// 依存なしの最小テストランナー。各テストに「入力」と「期待結果」を明記する。
const tests = [];
let currentSuite = '';

export function suite(name, fn) {
  currentSuite = name;
  fn();
  currentSuite = '';
}

/**
 * @param name テスト名
 * @param spec {input: string, expected: string}
 * @param fn 本体（async 可）
 */
export function test(name, spec, fn) {
  tests.push({ suite: currentSuite, name, spec, fn });
}

export class AssertionError extends Error {}

export function eq(actual, expected, msg = '') {
  const a = typeof actual === 'bigint' ? actual.toString() + 'n' : JSON.stringify(actual);
  const e = typeof expected === 'bigint' ? expected.toString() + 'n' : JSON.stringify(expected);
  if (a !== e) throw new AssertionError(`${msg ? msg + ': ' : ''}期待 ${e} / 実際 ${a}`);
}

export function ok(cond, msg = '条件が偽') {
  if (!cond) throw new AssertionError(msg);
}

export async function rejects(fn, codeOrRe, msg = '') {
  try {
    await fn();
  } catch (e) {
    if (codeOrRe instanceof RegExp) {
      if (!codeOrRe.test(e.message)) throw new AssertionError(`${msg} 例外メッセージ不一致: ${e.message}`);
    } else if (codeOrRe && e.code !== codeOrRe) throw new AssertionError(`${msg} 例外コード不一致: 期待 ${codeOrRe} / 実際 ${e.code} (${e.message})`);
    return e;
  }
  throw new AssertionError(`${msg} 例外が発生しませんでした`);
}

export async function run(onProgress) {
  const results = [];
  for (const t of tests) {
    const started = performance.now();
    let status = 'pass';
    let error = '';
    try {
      await t.fn();
    } catch (e) {
      status = 'fail';
      error = e?.stack || String(e);
    }
    const r = { suite: t.suite, name: t.name, input: t.spec.input, expected: t.spec.expected, status, error, ms: Math.round(performance.now() - started) };
    results.push(r);
    onProgress?.(r);
  }
  return results;
}
