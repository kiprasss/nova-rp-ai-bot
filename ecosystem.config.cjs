// Конфигурация pm2: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'nova-rp-ai',
      script: 'index.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      // Обновление базы знаний (скачивание сотен тем) поднимает память выше 300 МБ — pm2 перезапускал бота посреди обновления.
      max_memory_restart: '600M',
      time: true,
    },
  ],
};
