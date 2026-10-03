// 通用工具函数

/** 把任意字符串转成可作为规则文件名的 slug */
export function slugify(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'rule';
}

/** 数组化：string → [string]，数组原样，其余 → [] */
export function toList(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  return [];
}

/** 深比较两个 JSON 参数是否相等 */
export function argsEqual(a, b) {
  return JSON.stringify(normalizeArgs(a)) === JSON.stringify(normalizeArgs(b));
}

/** 归一化工具参数：缺失 → {}，非对象 → 包一层；键递归排序，保证同参不同键序判等 */
export function normalizeArgs(args) {
  if (args === undefined || args === null) return {};
  if (typeof args === 'object' && !Array.isArray(args)) {
    const sorted = {};
    for (const k of Object.keys(args).sort()) {
      const v = args[k];
      sorted[k] = v !== null && typeof v === 'object' ? normalizeArgs(v) : v;
    }
    return sorted;
  }
  return { __arg__: args };
}

/**
 * 解析事务键模板："${order_id}" / "${input.order_id}" / 字面量
 * 返回字符串形式的键值；路径缺失时返回 "__missing__"
 */
export function resolveKeyTemplate(template, args) {
  if (typeof template !== 'string') return '__missing__';
  const m = template.match(/^\$\{([^}]+)\}$/);
  if (!m) return template; // 字面量
  const path = m[1].split('.').map((p) => p.trim());
  let cur = normalizeArgs(args);
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object' || !(seg in cur)) return '__missing__';
    cur = cur[seg];
  }
  if (cur === undefined || cur === null) return '__missing__';
  return String(cur);
}
