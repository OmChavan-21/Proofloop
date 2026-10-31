/** Run solve(input) against a read-only suite in an isolated browser iframe. */
export function runTests(solveCode, tests) {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return Promise.reject(new Error('runTests requires a browser document.'));
  }

  const cases = Array.isArray(tests) ? tests : [];
  // Freeze cases and their values so neither the harness nor the user can
  // accidentally mutate the test oracle during a run.
  const freezeDeep = (value, seen = new WeakSet()) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) freezeDeep(value[key], seen);
    return Object.freeze(value);
  };
  freezeDeep(cases);

  return new Promise(resolve => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'display:none;width:0;height:0;border:0';

    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const results = [];
    let finished = false;
    let timer;
    const finish = timedOut => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      frame.remove();
      if (timedOut) {
        for (let i = results.length; i < cases.length; i++) {
          const test = cases[i] || {};
          results.push({
            name: test.name,
            input: test.input,
            expected: test.expected,
            got: undefined,
            passed: false,
            error: 'timeout'
          });
        }
      }
      resolve(results);
    };
    const onMessage = event => {
      if (event.source !== frame.contentWindow || !event.data || event.data.token !== token) return;
      if (event.data.type === 'result') results.push(event.data.result);
      if (event.data.type === 'done') finish(false);
    };

    window.addEventListener('message', onMessage);
    timer = setTimeout(() => finish(true), 3000);
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><script>
      const equal = (a, b, pairs = new WeakMap()) => {
        if (Object.is(a, b)) return true;
        if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
        if (Array.isArray(a) !== Array.isArray(b)) return false;
        if (pairs.get(a) === b) return true;
        pairs.set(a, b);
        const ak = Object.keys(a), bk = Object.keys(b);
        if (ak.length !== bk.length) return false;
        for (const key of ak) if (!Object.prototype.hasOwnProperty.call(b, key) || !equal(a[key], b[key], pairs)) return false;
        return true;
      };
      const send = (token, type, result) => parent.postMessage({ token, type, result }, '*');
      addEventListener('message', async event => {
        const data = event.data;
        if (!data || data.type !== 'run') return;
        let solve;
        try {
          solve = new Function(data.solveCode + '\\n;return solve;')();
          if (typeof solve !== 'function') throw new Error('solveCode must define function solve(input).');
        } catch (error) {
          for (const test of data.tests) {
            send(data.token, 'result', { name: test.name, input: test.input, expected: test.expected, got: undefined, passed: false, error: String(error && error.message || error) });
          }
          send(data.token, 'done');
          return;
        }
        for (const test of data.tests) {
          let got;
          let result;
          try {
            got = await solve(test.input);
            result = { name: test.name, input: test.input, expected: test.expected, got, passed: equal(got, test.expected), error: null };
          } catch (error) {
            result = { name: test.name, input: test.input, expected: test.expected, got: undefined, passed: false, error: String(error && error.message || error) };
          }
          try { send(data.token, 'result', result); }
          catch (error) {
            send(data.token, 'result', { name: test.name, input: test.input, expected: test.expected, got: String(got), passed: false, error: 'Result could not be transferred from sandbox.' });
          }
        }
        send(data.token, 'done');
      });
    <\/script>`;
    frame.onload = () => {
      try {
        frame.contentWindow.postMessage({
          type: 'run', token,
          solveCode: String(solveCode),
          tests: cases.map(test => ({ name: test.name, input: test.input, expected: test.expected }))
        }, '*');
      } catch (error) {
        results.push(...cases.map(test => ({ name: test.name, input: test.input, expected: test.expected, got: undefined, passed: false, error: String(error.message || error) })));
        finish(false);
      }
    };
    document.body.appendChild(frame);
  });
}
