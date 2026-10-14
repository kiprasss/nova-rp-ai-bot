import { PermissionFlagsBits, type Client, type Guild } from 'discord.js';
import { PROVIDERS, isProviderId, listModels, verifyToken } from '../ai/providers.js';
import { DEFAULT_SOURCES, config } from '../config.js';
import { secrets } from '../crypto.js';
import {
  addSource,
  deleteSource,
  ensureGuildRow,
  getRolePerm,
  getRolePerms,
  kbStats,
  listSources,
  newRolePerm,
  updateGuild,
  upsertRolePerm,
} from '../db/repo.js';
import { normalizeForumUrl } from '../forum/url.js';
import { applySetup, inspectSetup, syncAllRoleAccess } from './setupGuild.js';

export interface WizardCheck {
  ok: boolean;
  text: string;
}

export interface WizardAction {
  text: string;
  run: () => Promise<void> | void;
}

export interface WizardPlan {
  checks: WizardCheck[];
  actions: WizardAction[];
  /** Что можно сделать только вручную (например, ввести AI-токен). */
  manual: string[];
  /** После применения нужно обновить базу знаний. */
  needsRefresh: boolean;
}

/** Подразделы «Правила проекта» (/forums/893/) — при наличии 893 они дублируют индексацию. */
const RULES_SUBFORUMS = [1242, 1243, 896, 895, 1135];
const MOD_PERMS = [
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
];

/** Лимит вопросов в час для @everyone в зависимости от размера сервера. */
export function recommendedUserLimit(memberCount: number): number {
  if (memberCount <= 100) return 20;
  if (memberCount <= 1000) return 10;
  return 5;
}

/** Анализирует сервер и составляет список рекомендаций. Ничего не меняет. */
export async function analyzeGuild(client: Client, guild: Guild): Promise<WizardPlan> {
  const plan: WizardPlan = { checks: [], actions: [], manual: [], needsRefresh: false };
  const g = ensureGuildRow(guild.id, config.defaultRefreshHours);

  // 1. Права бота
  const me = guild.members.me;
  if (me?.permissions.has(PermissionFlagsBits.Administrator)) {
    plan.checks.push({ ok: true, text: 'Бот — администратор сервера' });
  } else {
    const need: [bigint, string][] = [
      [PermissionFlagsBits.ManageChannels, 'Управлять каналами'],
      [PermissionFlagsBits.ManageRoles, 'Управлять ролями'],
      [PermissionFlagsBits.ManageMessages, 'Управлять сообщениями'],
      [PermissionFlagsBits.ReadMessageHistory, 'Читать историю'],
    ];
    const missing = need.filter(([p]) => !me?.permissions.has(p)).map(([, n]) => n);
    plan.checks.push(missing.length ? { ok: false, text: `Боту не хватает прав: ${missing.join(', ')}` } : { ok: true, text: 'Права бота в порядке' });
    if (missing.length) plan.manual.push(`Выдайте роли бота права: ${missing.join(', ')} (Настройки сервера → Роли).`);
  }

  // 2. Каналы и меню
  const inspection = await inspectSetup(guild);
  if (inspection.missing.length) {
    plan.checks.push({ ok: false, text: `Не хватает: ${inspection.missing.join(', ')}` });
    plan.actions.push({ text: `Создать недостающее: ${inspection.missing.join(', ')}`, run: async () => void (await applySetup(client, guild)) });
  } else {
    plan.checks.push({ ok: true, text: 'Категория, каналы и меню на месте' });
  }

  // 3. AI-провайдер, токен и модель
  if (!isProviderId(g.ai_provider) || !g.ai_token) {
    plan.checks.push({ ok: false, text: 'AI-токен не настроен' });
    plan.manual.push('Откройте «🔑 AI-токен», выберите провайдера (бесплатный старт — **Groq**: console.groq.com) и введите токен.');
  } else {
    const provider = PROVIDERS[g.ai_provider];
    let token: string | null = null;
    try {
      token = secrets.decrypt(g.ai_token);
    } catch {
      plan.checks.push({ ok: false, text: 'AI-токен не расшифровывается (сменился ENCRYPTION_KEY)' });
      plan.manual.push('Введите AI-токен заново в «🔑 AI-токен».');
    }
    if (token) {
      const res = await verifyToken(provider.id, token);
      if (!res.ok) {
        plan.checks.push({ ok: false, text: `${provider.label}: ${res.message}` });
        plan.manual.push('Проверьте или замените AI-токен в «🔑 AI-токен».');
      } else {
        const model = g.ai_model || provider.defaultModel;
        const live = await listModels(provider.id, token, 2500);
        if (live && !live.includes(model)) {
          plan.checks.push({ ok: false, text: `${provider.label}: модель «${model}» недоступна` });
          plan.actions.push({ text: `Сменить модель на «${live[0]}» (доступна у провайдера)`, run: () => updateGuild(guild.id, { ai_model: live[0] }) });
        } else {
          plan.checks.push({ ok: true, text: `${provider.label} · ${model} — токен действителен` });
        }
      }
    }
  }

  // 4. Источники
  const sources = listSources(guild.id);
  const have = new Set(sources.map((s) => s.url));
  const recommended = DEFAULT_SOURCES.slice(0, 3)
    .map((u) => normalizeForumUrl(u, config.forumBaseUrl))
    .filter((n): n is NonNullable<typeof n> => !!n);
  const missingSources = recommended.filter((r) => !have.has(r.url));
  for (const r of missingSources) {
    plan.actions.push({ text: `Добавить источник ${r.url}`, run: () => void addSource(guild.id, r.url, r.kind, client.user!.id) });
  }
  const rulesRoot = recommended.find((r) => r.kind === 'forum' && r.id === 893);
  if (rulesRoot) {
    for (const s of sources) {
      const n = normalizeForumUrl(s.url, config.forumBaseUrl);
      if (n?.kind === 'forum' && RULES_SUBFORUMS.includes(n.id)) {
        plan.actions.push({ text: `Убрать дубль ${s.url} (уже входит в «Правила проекта» /forums/893/)`, run: () => deleteSource(s.id) });
      }
    }
  }
  plan.checks.push(
    missingSources.length
      ? { ok: false, text: `Источники: не хватает ${missingSources.length} рекомендуемых (все правила проекта, правила подачи жалоб, жалобы)` }
      : { ok: true, text: `Источники: ${sources.length}, рекомендуемые добавлены` },
  );

  if (sources.some((s) => s.last_error?.includes('защитой'))) {
    plan.checks.push({ ok: false, text: 'Форум закрыт защитой от ботов — обновление базы и проверка жалоб временно не работают' });
    plan.manual.push(
      'Попросите администрацию форума forum.grand-rp.su добавить бота в белый список (User-Agent из .env, IP сервера бота). До этого бот отвечает по уже собранной базе.',
    );
  }

  // 5. База знаний
  const kb = kbStats(guild.id);
  if (!kb.documents || !g.last_refresh_at) {
    plan.checks.push({ ok: false, text: 'База знаний ещё не собрана' });
    plan.needsRefresh = true;
  } else {
    plan.checks.push({ ok: true, text: `База знаний: тем ${kb.documents}, пунктов правил ${kb.rules}` });
  }
  if (plan.actions.some((a) => a.text.startsWith('Добавить источник') || a.text.startsWith('Убрать дубль'))) plan.needsRefresh = true;

  // 6. Лимиты под размер сервера
  const rec = recommendedUserLimit(guild.memberCount);
  const everyone = getRolePerm(guild.id, guild.id);
  if (everyone && everyone.hourly_limit !== 0 && everyone.hourly_limit !== rec) {
    plan.actions.push({
      text: `Лимит вопросов @everyone: ${everyone.hourly_limit} → ${rec} в час (участников: ${guild.memberCount})`,
      run: () => upsertRolePerm({ ...everyone, hourly_limit: rec }),
    });
  }
  plan.checks.push({ ok: true, text: `Участников: ${guild.memberCount} → рекомендуемый лимит ${rec} вопросов/час на человека` });

  // 7. Роли модераторов
  const configured = new Set(getRolePerms(guild.id).map((r) => r.role_id));
  const modRoles = [...guild.roles.cache.values()]
    .filter((r) => !r.managed && r.id !== guild.id && !configured.has(r.id))
    .filter((r) => !r.permissions.has(PermissionFlagsBits.Administrator) && MOD_PERMS.some((p) => r.permissions.has(p)))
    .sort((a, b) => b.position - a.position)
    .slice(0, 5);
  for (const r of modRoles) {
    plan.actions.push({
      text: `Роль «${r.name}» (модераторы): источники, FAQ, логи, видит #ai-настройки, любой канал, без лимита`,
      run: () =>
        upsertRolePerm(
          newRolePerm(guild.id, r.id, 0, { any_channel: 1, manage_sources: 1, view_logs: 1, see_settings: 1, hourly_limit: 0 }),
        ),
    });
  }
  plan.checks.push(
    modRoles.length
      ? { ok: false, text: `Найдены роли модераторов без настроек: ${modRoles.map((r) => r.name).join(', ')}` }
      : { ok: true, text: 'Роли модераторов настроены (или не найдены)' },
  );

  // 8. Настройки AI
  if (g.ai_rewrite !== 1) {
    plan.actions.push({ text: 'Включить «умный поиск» (AI исправляет опечатки и сленг перед поиском)', run: () => updateGuild(guild.id, { ai_rewrite: 1 }) });
  }
  if (guild.memberCount > 500 && g.ai_answer_length === 'long') {
    plan.actions.push({ text: 'Краткие ответы по умолчанию (большой сервер — меньше расход токенов)', run: () => updateGuild(guild.id, { ai_answer_length: 'short' }) });
  }

  plan.manual.push(
    'Чтобы скрыть команды бота от ролей в списке «/», откройте Настройки сервера → Интеграции → бот — там можно выбрать роли и каналы для каждой команды.',
  );
  return plan;
}

/** Применяет рекомендации и синхронизирует права каналов. Возвращает список выполненного. */
export async function applyPlan(guild: Guild, plan: WizardPlan): Promise<{ done: string[]; failed: string[] }> {
  const done: string[] = [];
  const failed: string[] = [];
  for (const a of plan.actions) {
    try {
      await a.run();
      done.push(a.text);
    } catch (err) {
      failed.push(`${a.text}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const problems = await syncAllRoleAccess(guild);
  if (problems.length) failed.push(`Права каналов не обновлены для: ${problems.join(', ')}`);
  return { done, failed };
}
