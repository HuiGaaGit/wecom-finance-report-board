import fs from 'node:fs';

const truthy = value => /^(?:1|true|yes|on)$/i.test(String(value || '').trim());
const safeEndpoint = (value, nodeEnv) => {
  try {
    const url = new URL(String(value || '').trim());
    const localTest = nodeEnv === 'test' && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
    if (url.protocol !== 'https:' && !localTest) return '';
    if (nodeEnv === 'production' && url.hostname !== 'open.bigmodel.cn') return '';
    if (url.username || url.password || url.search || url.hash) return '';
    return url.href.replace(/\/+$/, '');
  } catch { return ''; }
};

export const uploadMappingAssistantConfig = (env = process.env) => {
  const enabled = truthy(env.UPLOAD_MAPPING_LLM_ENABLED);
  const apiUrl = safeEndpoint(env.UPLOAD_MAPPING_LLM_API_URL, env.NODE_ENV);
  const model = String(env.UPLOAD_MAPPING_LLM_MODEL || '').trim().slice(0, 120);
  const keyFile = String(env.UPLOAD_MAPPING_LLM_API_KEY_FILE || '').trim();
  let apiKey = String(env.UPLOAD_MAPPING_LLM_API_KEY || '').trim();
  if (!apiKey && keyFile) {
    try {
      const stat = fs.statSync(keyFile);
      if (stat.isFile() && stat.size > 0 && stat.size <= 16 * 1024) apiKey = fs.readFileSync(keyFile, 'utf8').trim();
    } catch {}
  }
  const timeoutMs = Math.min(15_000, Math.max(1_000, Number(env.UPLOAD_MAPPING_LLM_TIMEOUT_MS) || 8_000));
  return { enabled, ready: enabled && Boolean(apiUrl && model && apiKey), apiUrl, model, apiKey, timeoutMs };
};

const jsonObjectFromText = value => {
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型未返回 JSON 对象');
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型返回结构无效');
  return parsed;
};

export const requestUploadMappingAdvice = async ({ config, task }) => {
  if (!config?.ready) return { status: config?.enabled ? 'unavailable' : 'disabled', tables: [] };
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const endpoint = /\/chat\/completions$/i.test(config.apiUrl) ? config.apiUrl : `${config.apiUrl}/chat/completions`;
    const response = await fetch(endpoint, {
      method: 'POST', signal: controller.signal,
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model, temperature: 0, max_tokens: 1200,
        messages: [
          { role: 'system', content: '你是财务工作簿结构识别助手。输入只含脱敏标题、字段名和坐标。只输出 JSON，不推算金额，不补造不存在的表。' },
          { role: 'user', content: JSON.stringify(task) }
        ]
      })
    });
    if (!response.ok) throw new Error(`模型服务响应 ${response.status}`);
    const payload = await response.json();
    const parsed = jsonObjectFromText(payload?.choices?.[0]?.message?.content);
    return { status: 'completed', tables: Array.isArray(parsed.tables) ? parsed.tables : [] };
  } catch (error) {
    return { status: error?.name === 'AbortError' ? 'timeout' : 'failed', tables: [] };
  } finally { clearTimeout(timer); }
};
