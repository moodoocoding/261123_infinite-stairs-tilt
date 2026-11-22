// Run: node qa/sensor-tests.cjs
// Deterministic event/game integration tests. No physical sensor is emulated by the browser.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const htmlPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const source = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
const results = [];

function game(options = {}) {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  function element() {
    const classes = new Set();
    return {
      style: {}, textContent: '', disabled: false, tagName: 'DIV', events: {},
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
      addEventListener(type, fn) { this.events[type] = fn; },
      getBoundingClientRect: () => ({ width: 420, height: 840, left: 0 }),
      setPointerCapture() {},
      getContext: () => new Proxy({}, { get: (_, name) => name === 'createLinearGradient'
        ? () => ({ addColorStop() {} }) : () => {}, set: () => true })
    };
  }
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1], element()]));
  const listeners = {};
  const documentListeners = {};
  const window = {
    location: { protocol: options.protocol || 'https:' },
    isSecureContext: options.secure !== false,
    DeviceOrientationEvent: options.orientation === false ? undefined : {},
    DeviceMotionEvent: options.motion === false ? undefined : {},
    addEventListener(type, fn) { (listeners[type] ??= new Set()).add(fn); },
    removeEventListener(type, fn) { listeners[type]?.delete(fn); }
  };
  if (options.permissions) {
    window.DeviceOrientationEvent = { requestPermission: () => options.permissions('orientation') };
    window.DeviceMotionEvent = { requestPermission: () => options.permissions('motion') };
  }
  const sandbox = {
    window,
    document: { hidden: false, getElementById: id => elements[id],
      addEventListener(type, fn) { documentListeners[type] = fn; } },
    screen: { orientation: { angle: 0, addEventListener(type, fn) { documentListeners.screenchange = fn; } } },
    performance: { now: () => now },
    localStorage: { getItem() { if (options.storageBlocked) throw Error('blocked'); return null; },
      setItem() { if (options.storageBlocked) throw Error('blocked'); } },
    requestAnimationFrame() {},
    setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id), console
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: htmlPath });
  window.onload();
  const run = code => vm.runInContext(code, context);
  function advance(ms, frame = false) {
    now += ms;
    for (const [id, t] of timers) if (t.at <= now) { timers.delete(id); t.fn(); }
    if (frame) run(`gameLoop(${now})`);
  }
  function emit(type, event) { for (const fn of listeners[type] ?? []) fn(event); }
  function sample(beta = 0, gamma = 0, ms = 50) {
    advance(ms);
    emit('deviceorientation', { beta, gamma });
  }
  function calibrate(beta = 0, gamma = 0) { for (let i = 0; i < 12; i++) sample(beta, gamma); }
  return { context, run, advance, emit, sample, calibrate, elements, listeners, documentListeners, sandbox };
}

async function test(name, fn) {
  try { await fn(); results.push({ name, passed: true }); }
  catch (e) { results.push({ name, passed: false, error: e.stack }); }
}

(async () => {
  await test('Concurrent motion events cannot overwrite fresh orientation readings', async () => {
    const g = game(); await g.run('enableTiltSensor()'); g.calibrate();
    g.sample(0, 20, 100);
    const before = g.run('currentTiltAngle');
    g.emit('devicemotion', { accelerationIncludingGravity: { x: -3.35, y: 0, z: 9.2 } });
    assert(before > 9); assert.equal(g.run('currentTiltAngle'), before);
    assert.equal(g.run('sensorSource'), 'orientation');
  });
  await test('Starting posture calibrates to neutral and does not auto-climb', async () => {
    const g = game(); await g.run('enableTiltSensor()'); g.run('startGame()'); g.calibrate(25, 18);
    assert.equal(g.run('sensorState'), 'ready');
    assert(Math.abs(g.run('currentTiltAngle')) < 1e-8);
    g.advance(50, true); assert.equal(g.run('currentStepIndex'), 0);
  });
  await test('Positive/negative physical tilts climb right/left stairs', async () => {
    for (const dir of [-1, 1]) {
      const g = game(); await g.run('enableTiltSensor()'); g.run('startGame()'); g.calibrate();
      g.run(`stairs[1].x = ${dir} * STEP_W; stairs[1].dir = ${dir}; stepCooldown = 0`);
      g.sample(0, dir * 22, 100); g.advance(16, true);
      assert.equal(g.run('currentStepIndex'), 1);
      assert.equal(g.run('player.x'), dir * 68); assert.equal(g.run('isFalling'), false);
    }
  });
  await test('Neutral jitter does not move character', async () => {
    const g = game(); await g.run('enableTiltSensor()'); g.run('startGame()'); g.calibrate();
    for (let i = 0; i < 25; i++) { g.sample(0, i % 2 ? 3 : -3); g.advance(16, true); }
    assert.equal(g.run('currentStepIndex'), 0); assert.equal(g.run('isFalling'), false);
  });
  await test('Gravity fallback has the same sign as orientation in all screen rotations', async () => {
    for (const rotation of [0, 90, 180, 270]) {
      const g = game({ orientation: false }); await g.run('enableTiltSensor()');
      g.sandbox.screen.orientation.angle = rotation;
      for (let i = 0; i < 12; i++) { g.advance(50); g.emit('devicemotion', { accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 } }); }
      const a = rotation * Math.PI / 180;
      g.advance(100); g.emit('devicemotion', { accelerationIncludingGravity: {
        x: -3.35 * Math.cos(a), y: 3.35 * Math.sin(a), z: 9.2
      } });
      assert(g.run('currentTiltAngle') > 9, `rotation ${rotation}`);
    }
  });
  await test('Orientation handles both landscape directions and upside-down portrait', async () => {
    for (const [rotation, beta, gamma] of [[0, 0, 20], [90, 20, 0], [180, 0, -20], [270, -20, 0]]) {
      const g = game(); await g.run('enableTiltSensor()');
      g.sandbox.screen.orientation.angle = rotation; g.calibrate(); g.sample(beta, gamma, 100);
      assert(g.run('currentTiltAngle') > 9, `rotation ${rotation}`);
    }
  });
  await test('Invalid, null, NaN and missing readings never activate sensors', async () => {
    const g = game(); await g.run('enableTiltSensor()');
    for (const event of [{}, { beta: null, gamma: null }, { beta: NaN, gamma: 9 }]) g.emit('deviceorientation', event);
    for (const acc of [{}, { x: null, y: null, z: null }, { x: 0, y: 0, z: 0 }]) g.emit('devicemotion', { accelerationIncludingGravity: acc });
    assert.equal(g.run('sensorState'), 'waiting'); assert.equal(g.run('currentTiltAngle'), 0);
  });
  await test('Stale readings stop movement; reconnection recalibrates', async () => {
    const g = game(); await g.run('enableTiltSensor()'); g.calibrate(); g.sample(0, 25, 100);
    g.advance(1300); g.run('refreshSensorState(performance.now())');
    assert.equal(g.run('sensorState'), 'lost'); assert.equal(g.run('currentTiltAngle'), 0);
    g.sample(0, 25); assert.equal(g.run('sensorState'), 'calibrating');
    g.calibrate(0, 25); assert(Math.abs(g.run('currentTiltAngle')) < 1e-8);
  });
  await test('Restart resets tilt, cooldown and neutral state', async () => {
    const g = game(); await g.run('enableTiltSensor()'); g.calibrate(); g.sample(0, 25, 100);
    g.run('stepCooldown = -8; neutralReturned = false; startGame()');
    assert.equal(g.run('currentTiltAngle'), 0); assert(g.run('stepCooldown') > 0);
    assert.equal(g.run('neutralReturned'), true); assert.equal(g.run('sensorState'), 'calibrating');
  });
  await test('Screen rotation pauses and recalibrates', async () => {
    const g = game(); await g.run('enableTiltSensor()'); g.calibrate();
    g.sandbox.screen.orientation.angle = 90; g.documentListeners.screenchange();
    assert.equal(g.run('sensorState'), 'calibrating'); assert.equal(g.run('currentTiltAngle'), 0);
  });
  await test('No-signal timeout leaves manual controls usable', async () => {
    const g = game(); await g.run('enableTiltSensor()'); g.run('startGame()'); g.advance(3100);
    assert.equal(g.run('sensorState'), 'unavailable');
    g.run('stairs[1].x = STEP_W'); g.elements['btn-right-step'].events.click();
    assert.equal(g.run('currentStepIndex'), 1);
  });
  await test('Both permission requests start within the initial click; partial grant works', async () => {
    const calls = [];
    const g = game({ permissions: type => { calls.push(type); return Promise.resolve(type === 'motion' ? 'granted' : 'denied'); } });
    const request = g.run('enableTiltSensor()');
    assert.deepEqual(calls, ['orientation', 'motion']); await request;
    assert(!g.listeners.deviceorientation); assert.equal(g.listeners.devicemotion.size, 1);
  });
  await test('Denied permissions show fallback status', async () => {
    for (const options of [{ permissions: () => Promise.resolve('denied') }]) {
      const g = game(options); await g.run('enableTiltSensor()');
      assert.equal(g.run('sensorState'), 'unavailable');
      assert.match(g.elements['live-sensor-status'].textContent, /방향 버튼/);
    }
  });
  await test('Downloaded Android files and insecure origins explain HTTPS instead of retrying', async () => {
    for (const options of [{ protocol: 'content:' }, { protocol: 'file:' }, { secure: false }]) {
      const g = game(options); await g.run('enableTiltSensor()');
      assert.equal(g.run('sensorState'), 'needs-https');
      assert.equal(g.elements['calibrate-btn'].disabled, true);
      assert.match(g.elements['live-sensor-status'].textContent, /HTTPS/);
      g.run('startGame(); stairs[1].x = STEP_W');
      g.elements['btn-right-step'].events.click();
      assert.equal(g.run('currentStepIndex'), 1);
    }
  });
  await test('Reconnect does not register duplicate event handlers', async () => {
    const g = game(); await g.run('enableTiltSensor()'); await g.run('enableTiltSensor()');
    assert.equal(g.listeners.deviceorientation.size, 1); assert.equal(g.listeners.devicemotion.size, 1);
  });
  await test('Keyboard arrows work and repeated keydown is ignored', async () => {
    const g = game(); g.run('startGame(); stairs[1].x = STEP_W; stairs[2].x = 2 * STEP_W;');
    const event = { key: 'ArrowRight', target: { tagName: 'BODY' }, preventDefault() {} };
    g.emit('keydown', event); assert.equal(g.run('currentStepIndex'), 1);
    g.emit('keydown', { ...event, repeat: true }); assert.equal(g.run('currentStepIndex'), 1);
  });
  await test('Swipe release does not create a second step; pointer cancellation clears state', async () => {
    const g = game(); g.run('startGame(); stairs[1].x = STEP_W; stairs[2].x = 2 * STEP_W;');
    const e = g.elements['stairs-canvas'].events;
    e.pointerdown({ clientX: 250, pointerId: 1 }); e.pointermove({ clientX: 280, pointerId: 1 });
    e.pointerup({ clientX: 280, pointerId: 1 }); assert.equal(g.run('currentStepIndex'), 1);
    e.pointerdown({ clientX: 250, pointerId: 1 }); e.pointercancel(); assert.equal(g.run('pointerId'), null);
  });
  await test('Calibration pauses stamina and background tabs do not advance game', async () => {
    const g = game(); await g.run('enableTiltSensor()'); g.run('startGame()');
    g.sample(); g.advance(50, true); assert.equal(g.run('stamina'), 100);
    g.sandbox.document.hidden = true; g.advance(50, true); assert.equal(g.run('stamina'), 100);
  });
  await test('Blocked local storage does not break start or game over', async () => {
    const g = game({ storageBlocked: true });
    g.run('startGame(); currentStepIndex = 5; endGame("test")');
    assert.equal(g.elements['final-steps'].textContent, 5);
  });
  const report = { type: 'synthetic sensor/game integration tests', physicalDeviceTested: false,
    passed: results.filter(r => r.passed).length, total: results.length, results };
  fs.writeFileSync(path.join(__dirname, 'test-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.passed !== report.total) process.exitCode = 1;
})();
