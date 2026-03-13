import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/api',
  'packages/web',
  'infra',
]);
