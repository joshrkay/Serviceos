import { createApp } from './app';

const PORT = parseInt(process.env.PORT || '3000', 10);
const app = createApp();

app.listen(PORT, () => {
  console.log(`ServiceOS API running on http://localhost:${PORT}`);
  console.log(`Swagger UI available at http://localhost:${PORT}/api-docs`);
  console.log(`Health check at http://localhost:${PORT}/health`);
});
