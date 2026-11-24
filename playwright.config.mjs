import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/browser', workers:1,
  use:{...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{}),
    viewport:{width:390,height:844},trace:'retain-on-failure'}
});

