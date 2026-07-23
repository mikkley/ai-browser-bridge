import { Pool } from 'pg'
import type { QueryResult, QueryResultRow } from 'pg'

// 薄封装: 路由层依赖这个接口而不是具体的 pg.Pool, 测试时注入假实现
export interface Db {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>
}

let pool: Pool | null = null

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString })
}

// 生产入口: 懒加载单例, 复用同一个连接池
export function getDb(): Db {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
      throw new Error('DATABASE_URL env var is required')
    }
    pool = createPool(connectionString)
  }
  return pool
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
