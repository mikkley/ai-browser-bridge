import { RELAY_WS_URL } from './config'

// wss://host/ws → https://host, ws://host/ws → http://host/ws
export const RELAY_HTTP_BASE = RELAY_WS_URL
  .replace(/^wss:\/\//, 'https://')
  .replace(/^ws:\/\//, 'http://')
  .replace(/\/ws$/, '')
