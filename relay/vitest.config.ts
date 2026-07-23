import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // 集成测试文件共享同一个真实 pg 实例, 用 TRUNCATE 做清理;
    // 并发跑多个文件会互相截断对方的数据, 必须串行
    fileParallelism: false,
  },
})
