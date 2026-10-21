const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const pendingKey = 'datahub_pending_registration';
const clone = (value) => JSON.parse(JSON.stringify(value));

// 每个用例隔离页面、模块及缓存；实际 api/request 只抵达这里的 wx.request。
function harness() {
  const storage = new Map();
  const requests = [];
  const intervals = new Map();
  let definition;
  let timer = 0;
  const app = { globalData: { cookie: '' } };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Page(value) { definition = value; },
    getApp: () => app,
    setInterval(fn) { intervals.set(++timer, fn); return timer; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout() { return ++timer; },
    clearTimeout() {},
    wx: {
      getStorageSync: (key) => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: (key) => storage.delete(key),
      showToast() {}, showModal() {}, showLoading() {}, hideLoading() {},
      request(options) {
        requests.push({ url: options.url, method: options.method, data: clone(options.data) });
        let data;
        if (options.url.includes('/wechatAddUser')) data = true;
        else if (options.url.includes('/VaildPhoneForRegiest')) data = 'OK';
        else if (options.url.includes('/getWeChatEmail')) data = true;
        else if (options.url.includes('/getRegisterStatus')) data = '未激活';
        else if (options.url.includes('/getIpAddr')) data = { success: true, RoleTeacher: false, RoleDoctor: true };
        else throw new Error(`Unexpected request: ${options.url}`);
        options.success({ statusCode: 200, header: {}, data });
      },
    },
  });
  const modules = new Map();
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} };
    modules.set(file, module);
    const code = fs.readFileSync(file, 'utf8');
    const wrapper = vm.runInContext(`(function(require, module, exports) {\n${code}\n})`, context, { filename: file });
    wrapper((name) => {
      assert.ok(name.startsWith('.'), `No external modules: ${name}`);
      return load(path.resolve(path.dirname(file), `${name}.js`));
    }, module, module.exports);
    return module.exports;
  }
  load(path.join(root, 'pages/register/register.js'));
  function page() {
    const instance = Object.assign({}, definition, { data: clone(definition.data) });
    instance.setData = (patch, callback) => {
      Object.entries(patch).forEach(([key, value]) => {
        const parts = key.split('.');
        let target = instance.data;
        parts.slice(0, -1).forEach((part) => { target = target[part]; });
        target[parts[parts.length - 1]] = value;
      });
      if (callback) callback();
    };
    return instance;
  }
  return { storage, requests, intervals, page, adds: () => requests.filter((r) => r.url.endsWith('/wechatAddUser')) };
}

function fill(page, identity, subIdentity = '') {
  Object.assign(page.data.form, {
    identity, subIdentity, schoolName: '测试大学', phone: '13800000000',
    name: '测试', college: '学院', department: '无', email: 'old@example.com',
    workEmail: 'old@example.com', studentId: '123', enrollmentYear: '2024', eduSystem: '3',
  });
  Object.assign(page.data, { certUrl: '/cert.png', protocolUrl: '/protocol.png', policyAgreed: true, step: 'form' });
  page.refreshComputed();
}

function checkIdentity(request, identity, label = '') {
  assert.equal(request.method, 'POST');
  const data = request.data;
  const expected = [identity === 'Doctor' ? 1 : 0, identity === 'Teacher' ? 1 : 0, identity === 'Other' ? 1 : 0];
  assert.deepEqual([data.bo, data.bos, data.isotheruser], expected);
  assert.equal(data.OtherUserIdentity, label);
  assert.ok(!('isdoctor' in data));
  assert.ok(!('isdoctorteach' in data));
  // 本地 Java DTO 收 String，服务端仅将字符串 "0" 解释为 false。
  assert.equal([data.bo, data.bos, data.isotheruser].map(String).filter((v) => v !== '0').length, 1);
}

async function main() {
  const cases = [
    ['Teacher', '', ''], ['Doctor', '', ''],
    ['Other', 'shuoshiidentity', '在读硕士生'],
    ['Other', 'benkeidentity', '在读本科生'],
    ['Other', 'otheridentity', '其他工作人员'],
  ];
  for (const [identity, sub, label] of cases) {
    const h = harness();
    const p = h.page();
    fill(p, identity, sub);
    if (identity === 'Teacher') {
      await p.goFromForm();
      assert.equal(p.data.step, 'agreement');
      assert.equal(h.adds().length, 1);
      assert.equal(await p.verifyRegisterBeforeAgreement(p.resolveEmail()), '');
    }
    await p.doSubmit();
    assert.equal(p.data.step, 'success');
    assert.equal(h.adds().length, 1);
    checkIdentity(h.adds()[0], identity, label);
    const record = JSON.parse(h.storage.get(pendingKey));
    assert.equal(record.identityMetadata.version, 1);
    assert.equal(record.identityMetadata.identity, identity);
    const restored = h.page();
    restored.restorePendingRegistration();
    assert.equal(restored.data.canModifyEmail, true);
    await restored.refreshRegistrationStatus();
    await restored.resendActivationEmail('new@example.com');
    assert.equal(h.adds().length, 2);
    checkIdentity(h.adds()[1], identity, label);
    assert.equal(h.adds()[1].data.email, 'new@example.com');
    assert.deepEqual(JSON.parse(h.storage.get(pendingKey)).identityMetadata, record.identityMetadata);
    for (const status of ['reviewing', 'approved', 'rejected', 'registered']) {
      restored.applyRegistrationStatus(status);
      const terminal = JSON.parse(h.storage.get(pendingKey));
      assert.ok(!terminal.payload && !terminal.identityMetadata);
      assert.equal(restored.data.submittedIdentity, null);
      restored.applyRegistrationStatus('unactivated');
      assert.equal(restored.data.canModifyEmail, false);
    }
    restored.resetAll();
    assert.equal(restored.data.submittedIdentity, null);
  }

  for (const identity of ['', 'Unknown', 'teacher', 'doctor', null, 1]) {
    const h = harness();
    const p = h.page();
    fill(p, identity);
    await p.goFromSchool();
    assert.equal(h.requests.length, 0);
    assert.equal(p.validateForm(), false);
    assert.throws(() => p.buildPayload('a@example.com'));
    assert.ok(await p.verifyRegisterBeforeAgreement('a@example.com'));
    await p.doSubmit();
    assert.equal(h.requests.length, 0);
    h.storage.set('datahub_register_state', JSON.stringify({ step: 'form', form: p.data.form }));
    const restored = h.page();
    restored.restoreState();
    assert.equal(restored.data.step, 'school');
    assert.equal(restored.data.form.identity, '');
  }
  for (const sub of ['', 'unknown', 'Shuoshiidentity', 'toString', null, 1]) {
    const h = harness();
    const p = h.page();
    fill(p, 'Other', sub);
    assert.equal(p.validateForm(), false);
    await p.doSubmit();
    assert.equal(h.adds().length, 0);
    h.storage.set('datahub_register_state', JSON.stringify({ step: 'form', form: p.data.form }));
    const restored = h.page();
    restored.restoreState();
    assert.equal(restored.data.form.subIdentity, '');
    await restored.doSubmit();
    assert.equal(h.adds().length, 0);
  }
  // 子身份在第三步选择，第一步合法 Other 空子身份必须仍能前进。
  {
    const h = harness(); const p = h.page(); fill(p, 'Other');
    await p.goFromSchool(); assert.equal(p.data.step, 'auth');
  }

  for (const identity of ['Teacher', 'Doctor']) {
    const h = harness(); const p = h.page(); fill(p, identity, 'otheridentity');
    await p.goFromSchool();
    assert.equal(p.data.form.identity, identity); // 学校 Role 字段不覆盖用户选择。
    await p.doSubmit();
    checkIdentity(h.adds()[0], identity);
  }

  const mutations = [
    (r) => { delete r.identityMetadata; },
    (r) => { delete r.identityMetadata.version; },
    (r) => { r.identityMetadata.version = 99; },
    (r) => { r.identityMetadata.version = '1'; },
    (r) => { r.identityMetadata.identity = 'teacher'; },
    (r) => { r.identityMetadata.identity = 'Other'; r.identityMetadata.subIdentity = 'unknown'; },
    (r) => { r.payload.bo = 0; r.payload.bos = 0; r.payload.isotheruser = 0; },
    (r) => { r.payload.bo = 1; },
    (r) => { r.payload.isotheruser = false; },
    (r) => { r.payload.bos = true; },
    (r) => { r.payload.bos = '1'; },
    (r) => { r.payload.isdoctor = false; },
    (r) => { r.payload.OtherUserIdentity = '其他工作人员'; },
    (r) => { r.phone = '13900000000'; },
    (r) => { delete r.payload; },
    (r) => { r.payload = 'legacy'; },
    (r) => { delete r.identityMetadata.subIdentity; },
  ];
  for (const mutate of mutations) {
    const h = harness(); const p = h.page(); fill(p, 'Teacher');
    await p.verifyRegisterBeforeAgreement(p.resolveEmail()); await p.doSubmit();
    const record = JSON.parse(h.storage.get(pendingKey)); mutate(record);
    h.storage.set(pendingKey, JSON.stringify(record));
    h.storage.delete('datahub_register_phone');
    const restored = h.page(); restored.restorePendingRegistration();
    assert.equal(restored.data.canModifyEmail, false);
    assert.ok(restored.data.emailResendWarning);
    assert.equal(restored.data.successEmail, record.email);
    assert.equal(restored.getCachedRegisterPhone(), record.phone);
    await restored.refreshRegistrationStatus();
    assert.equal(restored.data.canModifyEmail, false);
    restored.showRegistrationStatusForPhone(record.phone, 'unactivated');
    assert.equal(restored.data.canModifyEmail, false);
    for (const tick of h.intervals.values()) tick();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(restored.data.canModifyEmail, false);
    await assert.rejects(() => restored.resendActivationEmail('new@example.com'), /身份无法验证/);
    assert.equal(h.adds().length, 1);
    assert.ok(h.requests.some((r) => r.url.includes('/getRegisterStatus')));
  }

  for (const corrupt of [
    (p) => { p.data.submittedPayload = null; },
    (p) => { p.data.submittedIdentity = null; },
    (p) => { p.data.submittedPayload.bos = 0; },
    (p) => { p.data.form.identity = 'Doctor'; },
    (p) => { p.data.form.workEmail = 'changed@example.com'; },
    (p) => { p.data.form.phone = '13900000000'; },
    (p) => { p.data.teacherSubmittedBeforeAgreement = false; },
  ]) {
    const h = harness(); const p = h.page(); fill(p, 'Teacher');
    await p.goFromForm(); corrupt(p); await p.doSubmit();
    assert.notEqual(p.data.step, 'success');
    assert.ok(p.data.submitError);
    assert.equal(h.adds().length, 1);
  }
  console.log('register-identity: all offline regression tests passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
