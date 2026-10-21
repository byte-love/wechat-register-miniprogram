const api = require('../../utils/api');
const { registrationStatusEnabled } = require('../../utils/config');
const { isEmail, randomCode } = require('../../utils/validators');

const STORAGE_KEY = 'datahub_register_state';
const FORM_BACKUP_STORAGE_KEY = 'datahub_form_backup';
const REGISTER_PHONE_STORAGE_KEY = 'datahub_register_phone';
const PENDING_REGISTRATION_STORAGE_KEY = 'datahub_pending_registration';
const REGISTRATION_STATUS_POLL_INTERVAL = 5000;
const SUCCESS_EMAIL_ICON_SRC = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICA8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgyIDQpIiBmaWxsPSIjZmZmZmZmIj4KICAgIDxwYXRoIGQ9Ik0yLjIgMS4yIDkuNzYgNi44N2EuNC40IDAgMCAwIC40OCAwTDE3LjggMS4ySDIuMlptMTYuNi43NS03Ljg0IDUuODhhMS42IDEuNiAwIDAgMS0xLjkyIDBMMS4yIDEuOTVWMTQuOGgxNy42VjEuOTVaTTEgMGgxOGExIDEgMCAwIDEgMSAxdjE0YTEgMSAwIDAgMS0xIDFIMWExIDEgMCAwIDEtMS0xVjFhMSAxIDAgMCAxIDEtMVoiLz4KICA8L2c+Cjwvc3ZnPgo=';

const identityOptions = [
  { label: '教师', value: 'Teacher' },
  { label: '在读博士生', value: 'Doctor' },
  { label: '其他研究人员', value: 'Other' },
];

const subIdentityOptions = [
  { label: '在读硕士生', value: 'shuoshiidentity' },
  { label: '在读本科生', value: 'benkeidentity' },
  { label: '其他工作人员', value: 'otheridentity' },
];

const IDENTITY_CONTRACT_VERSION = 1;
const UNTRUSTED_REGISTRATION_MESSAGE = '缓存注册身份无法验证，暂不支持修改邮箱重发。仍可查询注册状态，请使用原激活邮件或联系客服。';
const subMap = {};
subIdentityOptions.forEach((option) => { subMap[option.value] = option.label; });

function getIdentityError(form, requireSubIdentity = true) {
  if (!identityOptions.some((option) => option.value === form.identity)) {
    return '身份无效，请返回第一步重新选择身份';
  }
  if (form.identity === 'Other'
    && (requireSubIdentity || form.subIdentity)
    && !subIdentityOptions.some((option) => option.value === form.subIdentity)) {
    return '请选择有效的其他研究人员身份选项';
  }
  return '';
}

function getIdentityMetadata(form) {
  return {
    version: IDENTITY_CONTRACT_VERSION,
    identity: form.identity,
    subIdentity: form.identity === 'Other' ? form.subIdentity : '',
  };
}

function buildIdentityPayload(form) {
  const error = getIdentityError(form);
  if (error) throw new Error(error);
  return {
    bo: form.identity === 'Doctor' ? 1 : 0,
    bos: form.identity === 'Teacher' ? 1 : 0,
    isotheruser: form.identity === 'Other' ? 1 : 0,
    OtherUserIdentity: form.identity === 'Other' ? subMap[form.subIdentity] : '',
  };
}

function isTrustedIdentity(payload, metadata) {
  if (!payload || typeof payload !== 'object' || !metadata || metadata.version !== IDENTITY_CONTRACT_VERSION
    || getIdentityError(metadata)
    || (metadata.identity !== 'Other' && metadata.subIdentity !== '')
    || !payload.mobifile
    || 'isdoctor' in payload || 'isdoctorteach' in payload) return false;
  const expected = buildIdentityPayload(metadata);
  return Object.keys(expected).every((key) => payload[key] === expected[key]);
}

function getPendingIdentityState(record) {
  const trusted = isTrustedIdentity(record.payload, record.identityMetadata)
    && record.payload.mobifile === record.phone;
  const canModifyEmail = record.status === 'unactivated' && trusted;
  return {
    submittedIdentity: record.identityMetadata || null,
    canModifyEmail,
    emailResendWarning: record.status === 'unactivated' && !trusted ? UNTRUSTED_REGISTRATION_MESSAGE : '',
  };
}

// 后端返回结构还没最终确认，几种常见形态都兼容一下。
function extractUploadUrl(body) {
  if (!body) return '';
  if (typeof body === 'string') return body;
  const data = body.data;
  if (typeof data === 'string' && data) return data;
  const candidates = [
    data && data.url,
    data && data.filePath,
    data && data.path,
    body.url,
    body.filePath,
    body.path,
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    if (candidates[i]) return candidates[i];
  }
  return '';
}

// 协议接口当前返回 { success, url }，同时兼容统一响应对象。
function extractAgreementUrl(body) {
  if (!body) return '';
  const candidates = [
    body.url,
    body.data && body.data.url,
    typeof body.data === 'string' ? body.data : '',
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    if (candidates[i]) return String(candidates[i]).trim();
  }
  return '';
}

// 学生身份取学生版协议，其他工作人员取通用版协议。
function resolveAgreementVersion(form) {
  const isStudent = form.identity === 'Doctor'
    || (form.identity === 'Other'
      && (form.subIdentity === 'shuoshiidentity' || form.subIdentity === 'benkeidentity'));
  return isStudent ? 1 : 0;
}

function isSupportedUploadImage(filePath) {
  const normalizedPath = String(filePath || '').split(/[?#]/)[0].toLowerCase();
  return /\.(jpg|png)$/.test(normalizedPath);
}

function downloadFile(url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success(res) {
        if (res.statusCode === 200 && res.tempFilePath) {
          resolve(res.tempFilePath);
          return;
        }
        reject(new Error(`协议文件下载失败，HTTP ${res.statusCode || '未知'}`));
      },
      fail: reject,
    });
  });
}

function openPdf(filePath) {
  return new Promise((resolve, reject) => {
    wx.openDocument({
      filePath,
      fileType: 'pdf',
      showMenu: true,
      success: resolve,
      fail: reject,
    });
  });
}

function downloadDocument(url) {
  return new Promise((resolve, reject) => {
    const cookie = getApp().globalData.cookie;
    wx.downloadFile({
      url,
      header: cookie ? { Cookie: cookie } : {},
      success(res) {
        if (res.statusCode === 200 && res.tempFilePath) {
          resolve(res);
          return;
        }
        reject(new Error(`注册信息文件下载失败，HTTP ${res.statusCode || '未知'}`));
      },
      fail: reject,
    });
  });
}

function openDocument(filePath, fileType) {
  return new Promise((resolve, reject) => {
    const options = {
      filePath,
      showMenu: true,
      success: resolve,
      fail: reject,
    };
    if (fileType) options.fileType = fileType;
    wx.openDocument(options);
  });
}

// 把后端原始错误消息映射为用户可读的中文提示。
// 能识别的关键词返回固定短语；后端给了中文且足够短就直接展示；其余情况兜底。
function isFalseResult(body) {
  if (body === false || body === 'false') return true;
  if (body && body.success === false) return true;
  if (body && body.data === false) return true;
  return false;
}

function isSuccessfulSubmitResult(body) {
  return body === true
    || body === 'true'
    || (typeof body === 'string' && body.trim().toLowerCase() === 'true');
}

function normalizeRegistrationStatus(body) {
  const data = body && body.data !== undefined ? body.data : body;
  const objectValue = data && typeof data === 'object' ? data : {};
  const rootValue = body && typeof body === 'object' ? body : {};
  if (objectValue.rejected === true || (body && body.rejected === true)) return 'rejected';

  const raw = objectValue.status !== undefined
    ? objectValue.status
    : (objectValue.registerStatus !== undefined
      ? objectValue.registerStatus
      : (objectValue.auditStatus !== undefined
        ? objectValue.auditStatus
        : (objectValue.state !== undefined
          ? objectValue.state
          : (rootValue.status !== undefined
            ? rootValue.status
            : (rootValue.registerStatus !== undefined
              ? rootValue.registerStatus
              : (rootValue.auditStatus !== undefined
                ? rootValue.auditStatus
                : (rootValue.state !== undefined ? rootValue.state : data)))))));
  const text = String(raw == null ? '' : raw).trim().toLowerCase();
  if (text === '手机号未注册') return 'not_registered';
  if (text === '未激活') return 'unactivated';
  if (text === '待审核') return 'reviewing';
  if (text === '驳回') return 'rejected';
  if (text === '审核通过，待开通' || text === '审核通过,待开通') return 'approved';

  // 保留兼容映射，方便后端以后改为英文枚举或返回 active 字段。
  if (/驳回|拒绝|reject|returned/.test(text)) return 'rejected';
  if (/审核通过|通过审核|approved|passed|accepted/.test(text)) return 'approved';
  if (/未激活|inactive|unactivated|not[_ -]?activated/.test(text)) return 'unactivated';
  if (/审核中|待审核|pending|reviewing|under[_ -]?review|submitted/.test(text)) return 'reviewing';

  const active = objectValue.active !== undefined
    ? objectValue.active
    : (body && body.active !== undefined ? body.active : undefined);
  if (active === false || active === 0 || active === 'false' || active === '0') return 'unactivated';
  if (active === true || active === 1 || active === 'true' || active === '1') return 'reviewing';
  return 'unknown';
}

function getSuccessViewState(status) {
  if (status === 'rejected') {
    return {
      successIconType: 'cancel',
      successIconColor: '#94a3b8',
      successTitle: '注册申请未通过',
      successDescription: '您的注册信息暂未通过审核，请核对后重新提交。',
      successEmailLabel: '',
      showSuccessEmail: false,
      successActionLabel: '重新注册',
      showRegistrationHelp: true,
      showAccountHelp: false,
    };
  }
  if (status === 'registered') {
    return {
      successIconType: 'success',
      successIconColor: '#2563eb',
      successTitle: '账号已注册',
      successDescription: '该手机号已关联 DataHub 账号，可前往 DataHub 官网登录使用。',
      successEmailLabel: '',
      showSuccessEmail: false,
      successActionLabel: '完成',
      showRegistrationHelp: false,
      showAccountHelp: true,
    };
  }
  if (status === 'approved') {
    return {
      successIconType: 'success',
      successIconColor: '#2563eb',
      successTitle: '审核通过',
      successDescription: '您的注册申请已审核通过，账号正在开通中，请耐心等待。',
      successEmailLabel: '注册邮箱：',
      showSuccessEmail: true,
      successActionLabel: '',
      showRegistrationHelp: false,
      showAccountHelp: false,
    };
  }
  if (status === 'reviewing') {
    return {
      successIconType: 'success',
      successIconColor: '#2563eb',
      successTitle: '激活成功',
      successDescription: '您已进入我司用户注册流程，我司会在1个工作日内反馈您的注册信息审核结果！',
      successEmailLabel: '注册邮箱：',
      showSuccessEmail: true,
      successActionLabel: '',
      showRegistrationHelp: false,
      showAccountHelp: false,
    };
  }
  return {
    successIconType: 'email',
    successIconColor: '#2563eb',
    successTitle: '提交成功',
    successDescription: '激活邮件已发送至您的邮箱，请及时登录激活，激活后方可进入注册流程。',
    successEmailLabel: '发送邮件至：',
    showSuccessEmail: true,
    successActionLabel: '',
    showRegistrationHelp: false,
    showAccountHelp: false,
  };
}

function mapBackendError(msg) {
  if (!msg) return '注册未通过：手机号或邮箱可能已被注册，请检查后重试；仍有问题请联系客服';
  const ml = msg.toLowerCase();
  if (
    (ml.includes('手机') || ml.includes('mobile') || ml.includes('tel') || ml.includes('phone'))
    && (ml.includes('注册') || ml.includes('exist') || ml.includes('重复') || ml.includes('already') || ml.includes('duplicate'))
  ) {
    return '该手机号已注册，如需找回账号，请前往官网登录页找回密码';
  }
  if (
    (ml.includes('邮箱') || ml.includes('email') || ml.includes('mail'))
    && (ml.includes('注册') || ml.includes('exist') || ml.includes('重复') || ml.includes('already') || ml.includes('duplicate'))
  ) {
    return '该邮箱已注册，如需找回账号，请前往官网登录页找回密码';
  }
  if (
    (ml.includes('学号') || ml.includes('studentno') || ml.includes('student_no'))
    && (ml.includes('注册') || ml.includes('exist') || ml.includes('重复') || ml.includes('already') || ml.includes('duplicate'))
  ) {
    return '该学号已注册，如需找回账号，请前往官网登录页找回密码';
  }
  if (ml.includes('timeout') || ml.includes('超时') || ml.includes('连接')) {
    return '网络超时，请检查网络连接后重试';
  }
  // 后端返回了可读的中文消息，直接展示给用户
  if (/[一-龥]/.test(msg) && msg.length <= 80) return msg;
  return '注册未通过：手机号或邮箱可能已被注册，请检查后重试；仍有问题请联系客服';
}

// 手机号预检接口成功时后端返回纯文本 "OK"，同时兼容旧文案与 success 对象格式。
function isPhoneAvailable(body) {
  const text = typeof body === 'string'
    ? body.trim()
    : ((body && (body.message || body.msg)) || '');
  return text === 'OK' || text === '手机号验证成功' || !!(body && body.success === true);
}

// 手机号接口用于补充识别已完成开通的账号，无法确认的响应继续交给状态接口处理。
function getPhoneRegistrationState(body) {
  if (isPhoneAvailable(body)) return 'available';
  const text = typeof body === 'string'
    ? body.trim().toLowerCase()
    : String((body && (body.message || body.msg || body.error)) || '').trim().toLowerCase();
  if (/已提交注册|已提交|submitted/.test(text)) return 'submitted';
  if (isFalseResult(body)) return 'registered';
  if (/已注册|已被绑定|already|exist|duplicate|bound/.test(text)) return 'registered';
  return 'unknown';
}

function defaultForm() {
  return {
    schoolName: '',
    identity: '',
    subIdentity: '',
    phone: '',
    name: '',
    college: '',
    department: '',
    email: '',
    studentId: '',
    enrollmentYear: '',
    eduSystem: '',
    emailType: 'workemail',
    workEmail: '',
    receiveSms: true,
    receiveEmail: true,
    certFileName: '',
    protocolFileName: '',
  };
}

function defaultErrors() {
  return {
    school: '',
    identity: '',
    subIdentity: '',
    name: '',
    college: '',
    department: '',
    email: '',
    workEmail: '',
    studentId: '',
    enrollmentYear: '',
    eduSystem: '',
    certFile: '',
    protocolFile: '',
    agree: '',
  };
}

Page({
  data: {
    step: 'school',
    stepIndex: 0,
    identityOptions,
    subIdentityOptions,
    form: defaultForm(),
    errors: defaultErrors(),
    schoolSuggest: [],
    schoolSuggestVisible: false,
    policyAgreed:false,
    checkingSchool: false,
    baseIPA: false,
    emailSuffix: '',
    showPhoneDept: true,
    showTeacherVerify: true,
    needStudentNo: false,
    needCertUpload: false,
    certUrl: '',
    protocolUrl: '',
    protocolDownloading: false,
    registrationInfoDownloading: false,
    agreed: false,
    submitting: false,
    submitError: '',
    exchangingPhone: false,
    authPhoneError: '',
    authShowManual: false,
    smscode:'',
    counting:false,
    count:60,
    teacherSubmittedBeforeAgreement: false,
    successEmail: '',
    successEmailIconSrc: SUCCESS_EMAIL_ICON_SRC,
    successIconType: 'email',
    successIconColor: '#2563eb',
    successTitle: '提交成功',
    successDescription: '激活邮件已发送至您的邮箱，请及时登录激活，激活后方可进入注册流程。',
    successEmailLabel: '发送邮件至：',
    showSuccessEmail: true,
    successActionLabel: '',
    showRegistrationHelp: false,
    showAccountHelp: false,
    submittedPayload: null,
    submittedIdentity: null,
    emailResendWarning: '',
    registrationStatus: 'unactivated',
    registrationStatusChecking: false,
    canModifyEmail: false,
    emailEditorVisible: false,
    emailDraft: '',
    emailEditWorkMode: false,
    emailEditSuffix: '',
    emailEditError: '',
    emailUpdating: false,
  },

  // ===== 生命周期：退出/后台时自动保存，回来时自动恢复 =====

  onLoad() {
    // 成功页已取消返回修改资料，清理旧版本留下的表单备份。
    try {
      wx.removeStorageSync(FORM_BACKUP_STORAGE_KEY);
    } catch (e) {
      // 静默失败
    }
    const pendingRegistration = this.restorePendingRegistration();
    if (pendingRegistration) {
      this.setStep('success');
      if (this.data.registrationStatus !== 'rejected'
        && this.data.registrationStatus !== 'registered') {
        this.refreshRegistrationStatus();
      }
      return;
    }
    // 关闭后重新打开、或被系统回收后重新进入，恢复之前填写的内容
    this.restoreState();
  },

  onShow() {
    if (this.data.step === 'success' && this.getCachedRegisterPhone()) {
      this.startRegistrationStatusPolling();
      if (this.data.registrationStatus !== 'rejected'
        && this.data.registrationStatus !== 'registered') {
        this.refreshRegistrationStatus();
      }
      return;
    }
    // 每次页面切入前台时也尝试恢复，兜底处理切后台后被系统回收的极端情况
    // 但只在当前数据为空时才恢复，避免覆盖正在编辑的内容
    if (!this.data.form.schoolName && !this.data.form.phone && !this.data.form.name) {
      this.restoreState();
    }
  },

  onHide() {
    this.clearRegistrationStatusTimer();
    if (this.data.step !== 'success') this.saveState();
  },

  onUnload() {
    this.clearSchoolTimer();
    clearInterval(this.timer);
    this.clearRegistrationStatusTimer();
  },

  saveState() {
    try {
      const data = {
        step: this.data.step,
        form: this.data.form,
        baseIPA: this.data.baseIPA,
        emailSuffix: this.data.emailSuffix,
        certUrl: this.data.certUrl,
        protocolUrl: this.data.protocolUrl,
        agreed: this.data.agreed,
      };
      wx.setStorageSync(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      // 静默失败
    }
  },

  restoreState() {
    try {
      const raw = wx.getStorageSync(STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || !data.form) return false;
      const patch = {};
      if (data.form) {
        Object.keys(defaultForm()).forEach((key) => {
          if (data.form[key] !== undefined) patch[`form.${key}`] = data.form[key];
        });
      }
      if (data.baseIPA !== undefined) patch.baseIPA = !!data.baseIPA;
      if (data.emailSuffix !== undefined) patch.emailSuffix = data.emailSuffix || '';
      if (data.certUrl !== undefined) patch.certUrl = data.certUrl || '';
      if (data.protocolUrl !== undefined) patch.protocolUrl = data.protocolUrl || '';
      if (data.agreed !== undefined) patch.agreed = !!data.agreed;
      const identityError = getIdentityError(data.form);
      if (!identityOptions.some((option) => option.value === data.form.identity)) {
        patch['form.identity'] = '';
        patch['form.subIdentity'] = '';
        patch['errors.identity'] = identityError;
      } else if (identityError) {
        patch['form.subIdentity'] = '';
        patch['errors.subIdentity'] = identityError;
      }
      this.setData(patch, () => this.refreshComputed());
      if (identityError) {
        this.setStep(patch['form.identity'] === '' ? 'school'
          : (/^(school|auth)$/.test(data.step) ? data.step : 'form'));
        return true;
      }
      // 恢复到上次所在步骤，但不超过 form（协议页不恢复）
      if (data.step && /^(school|auth|form)$/.test(data.step)) {
        this.setStep(data.step);
        return true;
      }
    } catch (e) {
      // 静默失败
    }
    return false;
  },

  clearSavedState() {
    try {
      wx.removeStorageSync(STORAGE_KEY);
    } catch (e) {
      // 静默失败
    }
  },

  savePendingRegistration(payload, email, identityMetadata) {
    try {
      const phone = String((payload && payload.mobifile) || '').trim();
      wx.setStorageSync(REGISTER_PHONE_STORAGE_KEY, phone);
      wx.setStorageSync(PENDING_REGISTRATION_STORAGE_KEY, JSON.stringify({
        phone,
        email,
        payload,
        emailSuffix: this.data.emailSuffix || '',
        status: 'unactivated',
        identityMetadata: identityMetadata || getIdentityMetadata(this.data.form),
      }));
    } catch (e) {
      // 静默失败
    }
  },

  restorePendingRegistration() {
    try {
      const raw = wx.getStorageSync(PENDING_REGISTRATION_STORAGE_KEY);
      if (!raw) return null;
      const record = JSON.parse(raw);
      if (!record || !record.phone) return null;
      const status = record.status || 'unactivated';
      if (status === 'reviewing' || status === 'approved' || status === 'rejected' || status === 'registered') {
        delete record.payload;
        delete record.identityMetadata;
        delete record.emailSuffix;
        this.updatePendingRegistrationStatus(status);
      }
      const email = record.email || (record.payload && record.payload.email) || '';
      const patch = {
        submittedPayload: record.payload || null,
        successEmail: email,
        emailSuffix: record.emailSuffix || '',
        registrationStatus: status,
        ...getPendingIdentityState(Object.assign({}, record, { status })),
      };
      Object.assign(patch, getSuccessViewState(status));
      if (!email) patch.showSuccessEmail = false;
      wx.setStorageSync(REGISTER_PHONE_STORAGE_KEY, String(record.phone).trim());
      this.setData(patch);
      return record;
    } catch (e) {
      return null;
    }
  },

  getCachedRegisterPhone() {
    try {
      return String(wx.getStorageSync(REGISTER_PHONE_STORAGE_KEY) || '').trim();
    } catch (e) {
      return '';
    }
  },

  clearPendingRegistration() {
    try {
      wx.removeStorageSync(REGISTER_PHONE_STORAGE_KEY);
      wx.removeStorageSync(PENDING_REGISTRATION_STORAGE_KEY);
    } catch (e) {
      // 静默失败
    }
  },

  updatePendingRegistrationStatus(status) {
    try {
      const raw = wx.getStorageSync(PENDING_REGISTRATION_STORAGE_KEY);
      if (!raw) return;
      const record = JSON.parse(raw);
      record.status = status;
      if (status === 'reviewing' || status === 'approved' || status === 'rejected' || status === 'registered') {
        delete record.payload;
        delete record.emailSuffix;
        delete record.identityMetadata;
      }
      wx.setStorageSync(PENDING_REGISTRATION_STORAGE_KEY, JSON.stringify(record));
    } catch (e) {
      // 静默失败
    }
  },

  showRegistrationStatusForPhone(phone, status) {
    let record = {};
    try {
      const raw = wx.getStorageSync(PENDING_REGISTRATION_STORAGE_KEY);
      const cached = raw ? JSON.parse(raw) : {};
      if (cached && String(cached.phone || '').trim() === phone) record = cached;
    } catch (e) {
      record = {};
    }

    record.phone = phone;
    record.status = status;
    if (status !== 'unactivated') {
      delete record.payload;
      delete record.emailSuffix;
      delete record.identityMetadata;
    }

    try {
      wx.setStorageSync(REGISTER_PHONE_STORAGE_KEY, phone);
      wx.setStorageSync(PENDING_REGISTRATION_STORAGE_KEY, JSON.stringify(record));
    } catch (e) {
      // 缓存失败时仍展示本次查询结果。
    }

    this.clearSavedState();
    const email = record.email || (record.payload && record.payload.email) || '';
    const patch = {
      submittedPayload: status === 'unactivated' ? (record.payload || null) : null,
      successEmail: email,
      emailSuffix: record.emailSuffix || '',
      registrationStatus: status,
      ...getPendingIdentityState(record),
      emailEditorVisible: false,
      authPhoneError: '',
      smsCodeError: '',
    };
    Object.assign(patch, getSuccessViewState(status));
    if (!email) patch.showSuccessEmail = false;
    this.setData(patch);
    this.setStep('success');
  },

  async checkPhoneBeforeRegistration(phone) {
    const phoneBody = await api.validPhoneForRegister(phone);
    const phoneState = getPhoneRegistrationState(phoneBody);
    if (phoneState === 'available') return { available: true };

    if (phoneState === 'registered') {
      this.showRegistrationStatusForPhone(phone, 'registered');
      return { available: false, handled: true };
    }

    if (phoneState === 'submitted') {
      const statusBody = await api.getRegistrationStatus(phone);
      const status = normalizeRegistrationStatus(statusBody);
      if (status === 'unactivated'
        || status === 'reviewing'
        || status === 'rejected'
        || status === 'approved') {
        this.showRegistrationStatusForPhone(phone, status);
        return { available: false, handled: true };
      }
      return { available: false, error: '该手机号已提交注册，暂时无法获取注册进度' };
    }

    return { available: false, error: '手机号状态校验失败，请稍后重试' };
  },

  clearRegistrationStatusTimer() {
    if (this.registrationStatusTimer) {
      clearInterval(this.registrationStatusTimer);
      this.registrationStatusTimer = null;
    }
  },

  startRegistrationStatusPolling() {
    this.clearRegistrationStatusTimer();
    if (!registrationStatusEnabled
      || this.data.step !== 'success'
      || this.data.registrationStatus === 'rejected'
      || this.data.registrationStatus === 'registered'
      || !this.getCachedRegisterPhone()) return;

    this.registrationStatusTimer = setInterval(() => {
      if (this.data.step !== 'success') {
        this.clearRegistrationStatusTimer();
        return;
      }
      this.refreshRegistrationStatus({ silent: true });
    }, REGISTRATION_STATUS_POLL_INTERVAL);
  },

  async refreshRegistrationStatus(options) {
    if (!registrationStatusEnabled) return 'unknown';
    const phone = this.getCachedRegisterPhone();
    if (!phone) return 'unknown';
    if (this.registrationStatusRequestPromise) return this.registrationStatusRequestPromise;

    const silent = !!(options && options.silent);
    if (!silent) this.setData({ registrationStatusChecking: true });

    this.registrationStatusRequestPromise = (async () => {
      try {
        if (this.data.registrationStatus === 'approved') {
          try {
            const phoneBody = await api.validPhoneForRegister(phone);
            if (getPhoneRegistrationState(phoneBody) === 'registered') {
              this.applyRegistrationStatus('registered');
              return 'registered';
            }
          } catch (err) {
            console.warn('[register] registered phone check failed', err);
          }
        }

        const body = await api.getRegistrationStatus(phone);
        let status = normalizeRegistrationStatus(body);
        if (status === 'not_registered') {
          try {
            const phoneBody = await api.validPhoneForRegister(phone);
            if (getPhoneRegistrationState(phoneBody) === 'registered') status = 'registered';
          } catch (err) {
            console.warn('[register] registered phone fallback failed', err);
          }
        }
        this.applyRegistrationStatus(status);
        return status;
      } catch (err) {
        if (/请先登录|未登录/.test(String((err && err.message) || err || ''))) {
          this.clearRegistrationStatusTimer();
        }
        console.warn('[register] registration status check failed', err);
        return 'unknown';
      } finally {
        this.registrationStatusRequestPromise = null;
        if (!silent) this.setData({ registrationStatusChecking: false });
      }
    })();
    return this.registrationStatusRequestPromise;
  },

  applyRegistrationStatus(status) {
    if (status === 'not_registered') {
      this.resetAll();
      return false;
    }
    if (status === 'unknown') return false;

    const retainPayload = status === 'unactivated';
    const terminalStatus = status === 'rejected' || status === 'registered';
    if (terminalStatus) this.clearRegistrationStatusTimer();
    this.updatePendingRegistrationStatus(status);
    const identityState = getPendingIdentityState({
      payload: retainPayload ? this.data.submittedPayload : null,
      identityMetadata: retainPayload ? this.data.submittedIdentity : null,
      phone: this.getCachedRegisterPhone(),
      status,
    });
    const patch = {
      registrationStatus: status,
      ...identityState,
      emailEditorVisible: identityState.canModifyEmail && this.data.emailEditorVisible,
      submittedPayload: retainPayload ? this.data.submittedPayload : null,
    };
    Object.assign(patch, getSuccessViewState(status));
    if (!this.data.successEmail) patch.showSuccessEmail = false;
    this.setData(patch);
    return status === 'unactivated';
  },

  // ===== 步骤控制 =====

  setStep(step) {
    const map = { school: 0, auth: 1, form: 2, agreement: 3, success: 3 };
    this.setData({ step, stepIndex: map[step] || 0 }, () => {
      // 提交成功后不再保存状态，避免缓存上一轮表单数据
      if (step !== 'success') this.saveState();
      if (step === 'success') this.startRegistrationStatusPolling();
      else this.clearRegistrationStatusTimer();
    });
  },

  setFormField(field, value) {
    this.setData({ [`form.${field}`]: value, [`errors.${field}`]: '' }, () => {
      this.refreshComputed();
      this.saveState();
    });
  },

  refreshComputed() {
    const { form, baseIPA } = this.data;
    const otherShowStudentId = form.subIdentity === 'shuoshiidentity' || form.subIdentity === 'benkeidentity';
    const needStudentNo = form.identity === 'Doctor' || (form.identity === 'Other' && otherShowStudentId);
    const specialTeacher = form.identity === 'Teacher' && baseIPA;
    const showPhoneDept = !(specialTeacher);
    const showTeacherVerify = form.identity === 'Teacher' && !specialTeacher;
    const needCertUpload = form.identity !== 'Teacher' || form.emailType === 'otherway';
    this.setData({ showPhoneDept, showTeacherVerify, needStudentNo, needCertUpload });
  },

  // ===== 第一步：学校校验 =====

  clearSchoolTimer() {
    if (this.schoolTimer) {
      clearTimeout(this.schoolTimer);
      this.schoolTimer = null;
    }
  },

  onSchoolFocus() {
    if (this.data.schoolSuggest.length) this.setData({ schoolSuggestVisible: true });
  },

  onSchoolInput(event) {
    const schoolName = event.detail.value;
    this.setData({ 'form.schoolName': schoolName, 'errors.school': '' });
    this.clearSchoolTimer();
    const keyword = schoolName.trim();
    if (!keyword) {
      this.setData({ schoolSuggest: [], schoolSuggestVisible: false });
      return;
    }
    this.schoolTimer = setTimeout(() => this.fetchSchoolSuggest(keyword), 250);
  },

  async fetchSchoolSuggest(keyword) {
    try {
      const res = await api.searchInstitutions(keyword);
      const list = Array.isArray(res) ? res : (res && Array.isArray(res.records) ? res.records : []);
      if (this.data.form.schoolName.trim() !== keyword) return;
      this.setData({ schoolSuggest: list, schoolSuggestVisible: list.length > 0 });
    } catch (err) {
      this.setData({ schoolSuggest: [], schoolSuggestVisible: false });
    }
  },

  selectSchool(event) {
    this.setData({
      'form.schoolName': event.currentTarget.dataset.name,
      schoolSuggest: [],
      schoolSuggestVisible: false,
      'errors.school': '',
    }, () => this.saveState());
  },

  onIdentityChange(event) {
    this.setData({
      'form.identity': event.detail.value,
      'form.subIdentity': '',
      'errors.identity': '',
      'errors.subIdentity': '',
    }, () => this.refreshComputed());
  },

  async goFromSchool() {
    if (!this.data.policyAgreed) {
      wx.showToast({ title: '请先阅读并同意协议', icon: 'none' })
      return
    }
    const schoolName = this.data.form.schoolName.trim();
    const identityError = getIdentityError(this.data.form, false);
    if (!schoolName) {
      this.setData({ 'errors.school': '请输入您的学校全称' });
      return;
    }
    if (identityError) {
      this.setData({ 'errors.identity': identityError });
      return;
    }

    this.setData({ checkingSchool: true, 'errors.school': '' });
    try {
      const data = await api.getIpAddr(schoolName);
      if (!data || !data.success) {
        this.setData({ 'errors.school': '非常抱歉，贵校尚未采购DataHub平台数据库，不能注册用户！' });
        wx.showModal({
          title: '提示',
          content: '非常抱歉，贵校尚未采购DataHub平台数据库，不能注册用户！请联系 DataHub 客服获取账号权限。',
          showCancel: false,
        });
        return;
      }
      this.setData({
        baseIPA: !!data.baseIPA,
        emailSuffix: data.suf ? String(data.suf).trim() : '',
      }, () => {
        this.refreshComputed();
        this.saveState();
        this.setStep('auth');
      });
    } catch (err) {
      this.setData({ 'errors.school': '学校校验失败，请稍后重试' });
    } finally {
      this.setData({ checkingSchool: false });
    }
  },

  onToggleAgree() {
    this.setData({ policyAgreed: !this.data.policyAgreed })
  },
  goUserService() {
    wx.navigateTo({ url: '/pages/agreement/user-service' })
  },
  goPrivacy() {
    wx.navigateTo({ url: '/pages/agreement/privacy' })
  },

  backToSchool() {
    this.setStep('school');
  },

  // ===== 第二步：微信手机号授权 =====

  async onGetPhoneNumber(e) {
    const detail = e.detail || {};
    if (detail.errMsg && detail.errMsg.indexOf('deny') >= 0) {
      this.setData({ authPhoneError: '您拒绝了手机号授权，请重新点击授权' });
      return;
    }
    if (!detail.code) {
      this.setData({ authPhoneError: '获取手机号失败，请稍后重试' });
      return;
    }

    this.setData({ exchangingPhone: true, authPhoneError: '' });

    try {
      const data = await api.exchangePhone(detail.code);
      console.log('[exchangePhone] response', data);
      if (!(data && data.success && data.phone)) {
        this.setData({
          authPhoneError: (data && data.message) || '手机号授权失败，请稍后重试',
          exchangingPhone: false,
        });
        return;
      }

      // 提前检查手机号是否已注册，让用户第一时间得到反馈，避免填完整张表才发现
      try {
        const phoneResult = await this.checkPhoneBeforeRegistration(data.phone);
        if (!phoneResult.available) {
          this.setData({
            authPhoneError: phoneResult.handled ? '' : phoneResult.error,
            exchangingPhone: false,
          });
          return;
        }
      } catch (err) {
        this.setData({
          authPhoneError: '手机号状态校验失败，请稍后重试',
          exchangingPhone: false,
        });
        return;
      }

      this.setData({ 'form.phone': data.phone, exchangingPhone: false }, () => {
        this.saveState();
        this.setStep('form');
      });
    } catch (err) {
      console.error('[exchangePhone] failed', err);
      this.setData({
        authPhoneError: `手机号授权失败：${(err && (err.message || err.errMsg)) || '请检查网络后重试'}`,
        exchangingPhone: false,
      });
    }
  },

  onShowManualPhone() {
    this.setData({ authShowManual: true, authPhoneError: '' });
  },

  onManualPhoneInput(e) {
    this.setData({ 'form.phone': e.detail.value, authPhoneError: '', smsCodeError: '' }, () => this.saveState());
  },

  async onConfirmManualPhone() {
    const phone = (this.data.form.phone || '').trim();
    if (!/^1\d{10}$/.test(phone)) {
      this.setData({ authPhoneError: '请输入正确的手机号' });
      return;
    }
    if (!this.data.smsCode) {
      this.setData({ smsCodeError: '请输入验证码' });
      return;
    }
    // 提前检查手机号是否已注册
    wx.showLoading({ title: '检查中', mask: true });
    try {
      const phoneResult = await this.checkPhoneBeforeRegistration(phone);
      if (!phoneResult.available) {
        wx.hideLoading();
        if (!phoneResult.handled) this.setData({ authPhoneError: phoneResult.error });
        return;
      }
    } catch (err) {
      wx.hideLoading();
      this.setData({ authPhoneError: '手机号状态校验失败，请稍后重试' });
      return;
    }
    try {
      const codeCheck = await api.validCode(phone, this.data.smsCode);
      wx.hideLoading();
      // 当前后端成功时返回纯文本“验证成功”，同时兼容对象格式的 success 字段
      const codeValid = codeCheck === '验证成功' || (codeCheck && codeCheck.success === true);
      if (!codeValid) {
        this.setData({ smsCodeError: '验证码有误或已过期' });
        return;
      }
    } catch (err) {
      wx.hideLoading();
      this.setData({ smsCodeError: '验证码校验失败，请稍后重试' });
      return;
    }
    // 进入下一步前把两个错误字段都清干净
    this.setData({ authShowManual: false, authPhoneError: '', smsCodeError: '' }, () => {
      this.saveState();
      this.setStep('form');
    });
  },

  onCodeInput(e){
    this.setData({ smsCode: e.detail.value, smsCodeError: '' })
  },

  async sendCode() {
    if (this.data.counting) return
    this.setData({ authPhoneError: '', smsCodeError: '' })
    const phone = (this.data.form.phone || '').trim()
    // 先校验格式，格式有误直接提示，省一次请求（正则和项目现有的保持一致）
    if (!/^1\d{10}$/.test(phone)) {
      this.setData({ authPhoneError: '请输入正确的手机号' })
      return
    }
    try {
      const phoneResult = await this.checkPhoneBeforeRegistration(phone)
      if (!phoneResult.available) {
        if (!phoneResult.handled) this.setData({ authPhoneError: phoneResult.error })
        return
      }
    } catch (e) {
      this.setData({ authPhoneError: '手机号状态校验失败，请稍后重试' })
      return
    }
    try {
      const result = await api.sendMessage(phone)
      const resultText = typeof result === 'string'
        ? result
        : String((result && (result.message || result.msg || result.error)) || '')
      if (/流控|限流|频繁|Permits/i.test(resultText)) {
        const message = /小时/.test(resultText)
          ? '该手机号短信发送已达每小时上限，请稍后再试，当前验证码未发送。'
          : '短信发送过于频繁，请稍后再试，当前验证码未发送。'
        this.setData({ smsCodeError: message })
        return
      }
      // 接口透传短信供应商消息；HTTP 200 不代表短信发送成功。
      if (resultText.trim() !== 'OK') {
        this.setData({ smsCodeError: '验证码发送未成功，请稍后重试；仍有问题请联系客服' })
        return
      }
      wx.showToast({ title: '验证码已发送', icon: 'none' })
      this.startCountdown()
    } catch (e) {
      const errorText = String((e && (e.message || e.errMsg)) || e || '')
      const message = /流控|限流|频繁|Permits/i.test(errorText)
        ? '短信发送次数已达到限制，请稍后再试，当前验证码未发送。'
        : '发送失败，请稍后重试'
      this.setData({ smsCodeError: message })
    }
  },
  startCountdown() {
    this.setData({ counting: true, count: 60 })
    this.timer = setInterval(() => {
      const next = this.data.count - 1
      if (next <= 0) {
        clearInterval(this.timer)
        this.setData({ counting: false })
        return
      }
      this.setData({ count: next })
    }, 1000)
  },

  onCancelManualPhone() {
    this.setData({ authShowManual: false, authPhoneError: '', 'form.phone': '' }, () => this.saveState());
  },

  // ===== 第三步：资料表单 =====

  onSubIdentityChange(event) {
    this.setData({ 'form.subIdentity': event.detail.value, 'errors.subIdentity': '' }, () => this.refreshComputed());
  },

  onEmailTypeChange(event) {
    this.setData({ 'form.emailType': event.detail.value }, () => this.refreshComputed());
  },

  onTextInput(event) {
    this.setFormField(event.currentTarget.dataset.field, event.detail.value);
  },

  toggleSms() {
    this.setData({ 'form.receiveSms': !this.data.form.receiveSms }, () => this.saveState());
  },

  toggleEmail() {
    this.setData({ 'form.receiveEmail': !this.data.form.receiveEmail }, () => this.saveState());
  },

  toggleAgree() {
    this.setData({ agreed: !this.data.agreed, 'errors.agree': '' }, () => this.saveState());
  },

  async downloadRegistrationInfo() {
    if (this.data.registrationInfoDownloading) return;
    this.setData({ registrationInfoDownloading: true });
    wx.showLoading({ title: '文件下载中', mask: true });
    try {
      const response = await downloadDocument(api.getAllMessageDocUrl());
      // 接口返回 DataHub新用户注册信息.docx，URL 本身没有扩展名，需要明确指定文件类型。
      await openDocument(response.tempFilePath, 'docx');
    } catch (err) {
      console.error('[registration-info] 下载或打开失败', err);
      const detail = (err && (err.message || err.errMsg)) || '请稍后重试';
      wx.showModal({ title: '文件获取失败', content: detail, showCancel: false });
    } finally {
      wx.hideLoading();
      this.setData({ registrationInfoDownloading: false });
    }
  },

  chooseImage(event) {
    const type = event.currentTarget.dataset.type;
    const clearInvalidSelection = (message) => {
      if (type === 'cert') {
        this.setData({
          certUrl: '',
          'form.certFileName': '',
          'errors.certFile': message,
        }, () => this.saveState());
        return;
      }
      this.setData({
        protocolUrl: '',
        'form.protocolFileName': '',
        'errors.protocolFile': message,
      }, () => this.saveState());
    };
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        if (!isSupportedUploadImage(file.tempFilePath)) {
          clearInvalidSelection('仅支持 .jpg、.png 格式');
          return;
        }
        const size = file.size || 0;
        if (type === 'protocol' && size > 8 * 1024 * 1024) {
          clearInvalidSelection('文件大小须小于或等于 8M');
          return;
        }
        this.previewAndUpload(type, file.tempFilePath);
      },
    });
  },

  previewAndUpload(type, filePath) {
    wx.previewImage({
      current: filePath,
      urls: [filePath],
      success: () => this.uploadChosenImage(type, filePath),
      fail: () => this.uploadChosenImage(type, filePath),
    });
  },

  async uploadChosenImage(type, filePath) {
    wx.showLoading({ title: '上传中', mask: true });
    let uploaded = false;
    try {
      const body = await api.uploadRegisterFile(filePath);
      const url = extractUploadUrl(body);
      if (!url) throw new Error(`返回里没找到 url: ${JSON.stringify(body).slice(0, 200)}`);
      const name = filePath.split('/').pop() || '已上传图片';
      if (type === 'cert') {
        this.setData({ certUrl: url, 'form.certFileName': name, 'errors.certFile': '' }, () => this.saveState());
      } else {
        this.setData({ protocolUrl: url, 'form.protocolFileName': name, 'errors.protocolFile': '' }, () => this.saveState());
      }
      uploaded = true;
    } catch (err) {
      console.error('[upload] 失败', err);
      const detail = (err && (err.errMsg || err.message)) || '未知错误';
      this.setData({ [`errors.${type === 'cert' ? 'certFile' : 'protocolFile'}`]: `上传失败：${detail}` });
    } finally {
      wx.hideLoading();
    }
    if (uploaded) wx.showToast({ title: '上传成功', icon: 'success' });
  },

  downloadProtocol() {
    if (this.data.protocolDownloading) return;
    const schoolName = (this.data.form.schoolName || '').trim();
    const version = resolveAgreementVersion(this.data.form);
    if (!schoolName) {
      wx.showToast({ title: '请先选择学校', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '下载协议',
      content: `确定下载${schoolName}适用的《DataHub 平台数据使用协议》吗？`,
      confirmText: '确定',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) this.fetchAndOpenProtocol(schoolName, version);
      },
    });
  },

  async fetchAndOpenProtocol(schoolName, version) {
    if (this.data.protocolDownloading) return;
    this.setData({ protocolDownloading: true });
    wx.showLoading({ title: '协议下载中', mask: true });
    try {
      const body = await api.getDataHubAgreementPDF(schoolName, version);
      const url = extractAgreementUrl(body);
      if (!url) {
        throw new Error((body && (body.message || body.msg)) || '该学校暂未配置协议文件');
      }
      const filePath = await downloadFile(url);
      await openPdf(filePath);
    } catch (err) {
      console.error('[agreement] 下载或打开失败', err);
      const detail = (err && (err.message || err.errMsg)) || '请稍后重试';
      wx.showModal({ title: '协议获取失败', content: detail, showCancel: false });
    } finally {
      wx.hideLoading();
      this.setData({ protocolDownloading: false });
    }
  },

  // ===== 表单校验与提交 =====

  validateForm() {
    const form = this.data.form;
    const errors = defaultErrors();
    let ok = true;
    const need = (value) => !String(value || '').trim();
    const full = !(form.identity === 'Teacher' && this.data.baseIPA);

    const identityError = getIdentityError(form);
    if (identityError) {
      const field = form.identity === 'Other' ? 'subIdentity' : 'identity';
      this.setData({ [`errors.${field}`]: identityError, submitError: identityError });
      if (field === 'identity') this.setStep('school');
      return false;
    }
    if (need(form.name)) {
      errors.name = '必填项';
      ok = false;
    }
    if (need(form.phone)) {
      errors.name = '未获取手机号，请返回上一步重新授权';
      ok = false;
    }
    if (need(form.college)) {
      errors.college = '必填项';
      ok = false;
    }
    if (full && need(form.department)) {
      errors.department = '必填项，如没有系别可填无';
      ok = false;
    }

    if (form.identity === 'Teacher' && form.emailType === 'workemail') {
      if (need(form.workEmail)) {
        errors.workEmail = '必填项';
        ok = false;
      }
    } else if (need(form.email)) {
      errors.email = '必填项';
      ok = false;
    } else if (!isEmail(form.email)) {
      errors.email = '邮件格式不正确';
      ok = false;
    }

    if (this.data.needStudentNo && need(form.studentId)) {
      errors.studentId = '必填项';
      ok = false;
    }
    if (form.identity === 'Doctor' || form.identity === 'Other') {
      if (need(form.enrollmentYear)) {
        errors.enrollmentYear = '必填项';
        ok = false;
      } else {
        const enrollmentYear = String(form.enrollmentYear).trim();
        const currentYear = new Date().getFullYear();
        if (!/^\d{4}$/.test(enrollmentYear) || Number(enrollmentYear) < 1900 || Number(enrollmentYear) > currentYear) {
          errors.enrollmentYear = `请输入 1900 至 ${currentYear} 年之间的四位年份`;
          ok = false;
        }
      }
      if (need(form.eduSystem)) {
        errors.eduSystem = '必填项';
        ok = false;
      } else {
        const eduSystem = String(form.eduSystem).trim();
        if (!/^(?:[1-9](?:\.\d)?|10(?:\.0)?)$/.test(eduSystem)) {
          errors.eduSystem = '请输入 1 至 10 年的学制，最多保留一位小数';
          ok = false;
        }
      }
    }

    if (this.data.needCertUpload && !this.data.certUrl) {
      errors.certFile = '请上传证件照片';
      ok = false;
    }
    if (form.identity !== 'Teacher' && !this.data.protocolUrl) {
      errors.protocolFile = '请上传协议照片';
      ok = false;
    }

    this.setData({ errors, submitError: '' });
    return ok;
  },

  async checkRegisterOccupied(email) {
    console.log('[register] check occupied before next');
    const phone = this.data.form.phone.trim();

    const phoneBody = await api.validPhoneForRegister(phone);
    if (isFalseResult(phoneBody)) {
      return '该手机号已注册，如需找回账号，请前往官网登录页找回密码';
    }

    return this.checkEmailOccupied(email);
  },

  async checkEmailOccupied(email, occupiedMessage) {
    const submittedBaseIPA = this.data.submittedPayload && this.data.submittedPayload.baseIPA;
    const baseIPA = submittedBaseIPA !== undefined ? submittedBaseIPA : (this.data.baseIPA ? 1 : 0);
    const emailBody = await api.getRegisterEmail(email, baseIPA);
    if (isFalseResult(emailBody)) {
      return occupiedMessage || '该邮箱已注册，如需找回账号，请前往官网登录页找回密码';
    }

    return '';
  },

  getTeacherSnapshotError(email) {
    const payload = this.data.submittedPayload;
    if (!this.data.teacherSubmittedBeforeAgreement
      || this.data.form.identity !== 'Teacher'
      || !isTrustedIdentity(payload, this.data.submittedIdentity)
      || this.data.submittedIdentity.identity !== 'Teacher') {
      return '已提交的教师注册快照无法验证，请查询注册状态或联系客服，勿重复提交';
    }
    const current = this.buildPayload(email);
    return Object.keys(current).some((key) => key !== 'random' && current[key] !== payload[key])
      ? '资料与已提交的教师注册信息不一致，请恢复原资料或联系客服，勿重复提交'
      : '';
  },

  async verifyRegisterBeforeAgreement(email) {
    const identityError = getIdentityError(this.data.form);
    if (identityError) return identityError;
    if (this.data.teacherSubmittedBeforeAgreement) return this.getTeacherSnapshotError(email);
    if (this.data.form.identity !== 'Teacher') return '请返回第一步重新选择教师身份';
    const payload = this.buildPayload(email);
    const identityMetadata = getIdentityMetadata(this.data.form);
    const occupiedError = await this.checkRegisterOccupied(email);
    if (occupiedError) return occupiedError;

    const result = await api.addUser(payload);
    const ok = isSuccessfulSubmitResult(result);
    if (ok) {
      this.setData({ teacherSubmittedBeforeAgreement: true, submittedPayload: payload, submittedIdentity: identityMetadata });
      return '';
    }

    const backendMsg = (result && typeof result === 'object')
      ? (result.message || result.msg || result.error || '')
      : '';
    return backendMsg ? mapBackendError(backendMsg) : '注册未通过：手机号或邮箱可能已被注册，请检查后重试；仍有问题请联系客服';
  },

  async goFromForm() {
    if (!this.validateForm()) return;
    if (this.data.form.identity === 'Teacher') {
      if (this.data.submitting) return;
      this.setData({ submitting: true, submitError: '' });
      try {
        const verifyError = await this.verifyRegisterBeforeAgreement(this.resolveEmail());
        if (verifyError) {
          this.setData({ submitError: verifyError });
          return;
        }
        this.setStep('agreement');
      } catch (err) {
        this.setData({ submitError: mapBackendError((err && err.message) || '') });
      } finally {
        this.setData({ submitting: false });
      }
      return;
    }
    this.doSubmit();
  },

  submitAfterAgreement() {
    if (!this.data.agreed) {
      this.setData({ 'errors.agree': '请阅读DataHub平台数据使用协议' });
      return;
    }
    this.doSubmit();
  },

  resolveEmail() {
    const { form, emailSuffix } = this.data;
    if (form.identity === 'Teacher' && form.emailType === 'workemail') {
      const value = form.workEmail.trim();
      if (value.indexOf('@') >= 0) return value;
      const suffix = (emailSuffix || '').split(',')[0].trim();
      return suffix ? value + suffix : value;
    }
    return form.email.trim();
  },

  buildPayload(email) {
    const { form, baseIPA, certUrl, protocolUrl, needStudentNo } = this.data;
    const isDoctor = form.identity === 'Doctor';
    const isOther = form.identity === 'Other';
    const identityPayload = buildIdentityPayload(form);

    return {
      fileAgree: protocolUrl || '',
      fileRegister: certUrl || '',
      email,
      name: form.name.trim(),
      college: form.college.trim(),
      xibie: form.department.trim(),
      mobifile: form.phone.trim(),
      ...identityPayload,
      other: '',
      emailstatus: form.identity === 'Teacher' && form.emailType === 'workemail' ? 1 : 0,
      random: randomCode(),
      Okstatus: 0,
      status: 0,
      school: form.schoolName.trim(),
      isactive: 0,
      bodaoname: '',
      StudentNo: needStudentNo ? form.studentId.trim() : '',
      sendMessage: form.receiveSms ? 1 : 0,
      sendEmail: form.receiveEmail ? 1 : 0,
      baseIPA: baseIPA ? 1 : 0,
      xuezhi: (isDoctor || isOther) ? form.eduSystem.trim() : '',
      ruxueyear: (isDoctor || isOther) ? form.enrollmentYear.trim() : '',
    };
  },

  async doSubmit() {
    if (this.data.submitting) return;

    if (!this.validateForm()) return;

    if (this.data.teacherSubmittedBeforeAgreement || this.data.step === 'agreement') {
      const error = this.getTeacherSnapshotError(this.resolveEmail());
      if (error) {
        this.setData({ submitError: error });
        return;
      }
      this.completeSubmission(this.data.submittedPayload, this.data.submittedPayload.email, this.data.submittedIdentity);
      return;
    }

    this.setData({ submitting: true, submitError: '' });
    const email = this.resolveEmail();
    const payload = this.buildPayload(email);
    const identityMetadata = getIdentityMetadata(this.data.form);

    try {
      const occupiedError = await this.checkRegisterOccupied(email);
      if (occupiedError) {
        this.setData({ submitError: occupiedError });
        this.setStep('form');
        return;
      }

      // 提交注册
      const result = await api.addUser(payload);
      const ok = isSuccessfulSubmitResult(result);
      if (!ok) {
        // addUser 只返回 false 时没有具体原因，只能给用户可行动的可能原因。
        const backendMsg = (result && typeof result === 'object')
          ? (result.message || result.msg || result.error || '')
          : '';
        const fallback = '注册未通过：手机号或邮箱可能已被注册，请检查后重试；仍有问题请联系客服';
        this.setData({ submitError: backendMsg ? mapBackendError(backendMsg) : fallback });
        this.setStep('form');
        return;
      }

      this.completeSubmission(payload, email, identityMetadata);
    } catch (err) {
      this.setData({ submitError: mapBackendError((err && err.message) || '') });
      if (this.data.step === 'agreement') this.setStep('form');
    } finally {
      this.setData({ submitting: false });
    }
  },

  completeSubmission(payload, email, identityMetadata) {
    this.clearSavedState();
    this.savePendingRegistration(payload, email, identityMetadata);
    const patch = {
      form: defaultForm(),
      teacherSubmittedBeforeAgreement: false,
      submittedPayload: payload,
      submittedIdentity: identityMetadata,
      emailResendWarning: '',
      successEmail: email,
      registrationStatus: 'unactivated',
      canModifyEmail: true,
    };
    this.setData(Object.assign(patch, getSuccessViewState('unactivated')));
    this.setStep('success');
  },

  resetAll() {
    this.clearSavedState();
    this.clearPendingRegistration();
    getApp().globalData.cookie = '';
    this.setData({
      form: defaultForm(),
      errors: defaultErrors(),
      schoolSuggest: [],
      schoolSuggestVisible: false,
      baseIPA: false,
      emailSuffix: '',
      certUrl: '',
      protocolUrl: '',
      protocolDownloading: false,
      registrationInfoDownloading: false,
      agreed: false,
      submitError: '',
      authPhoneError: '',
      authShowManual: false,
      teacherSubmittedBeforeAgreement: false,
      successEmail: '',
      successIconType: 'email',
      successIconColor: '#2563eb',
      successTitle: '提交成功',
      successDescription: '激活邮件已发送至您的邮箱，请及时登录激活，激活后方可进入注册流程。',
      successEmailLabel: '发送邮件至：',
      showSuccessEmail: true,
      successActionLabel: '',
      showRegistrationHelp: false,
      showAccountHelp: false,
      submittedPayload: null,
      submittedIdentity: null,
      emailResendWarning: '',
      registrationStatus: 'unactivated',
      registrationStatusChecking: false,
      canModifyEmail: false,
      emailEditorVisible: false,
      emailDraft: '',
      emailEditWorkMode: false,
      emailEditSuffix: '',
      emailEditError: '',
      emailUpdating: false,
    }, () => {
      this.refreshComputed();
      this.setStep('school');
    });
  },

  finishRegistrationResult() {
    this.resetAll();
  },

  // ===== 资料页返回按钮：回到授权 =====
  backToAuth() {
    this.setStep('auth');
  },

  backToForm() {
    this.setStep('form');
  },

  resolveEmailEditSuffix(email) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const suffixes = String(this.data.emailSuffix || '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .map((suffix) => (suffix.indexOf('@') >= 0 ? suffix.slice(suffix.indexOf('@')) : `@${suffix}`));
    const matchedSuffix = suffixes.find((suffix) => normalizedEmail.endsWith(suffix));
    if (matchedSuffix) return matchedSuffix;

    const atIndex = normalizedEmail.indexOf('@');
    return atIndex >= 0 ? normalizedEmail.slice(atIndex) : '';
  },

  async openEmailEditor() {
    if (!this.data.canModifyEmail) return;
    this.setData({ registrationStatusChecking: true });
    const currentStatus = await this.refreshRegistrationStatus({ silent: true });
    this.setData({ registrationStatusChecking: false });
    if (currentStatus !== 'unactivated' && currentStatus !== 'unknown') return;
    if (!this.data.canModifyEmail) return;

    const workMode = !!(this.data.submittedPayload
      && Number(this.data.submittedPayload.emailstatus) === 1);
    const suffix = workMode ? this.resolveEmailEditSuffix(this.data.successEmail) : '';
    const currentEmail = String(this.data.successEmail || '').trim();
    const draft = workMode && suffix && currentEmail.toLowerCase().endsWith(suffix)
      ? currentEmail.slice(0, currentEmail.length - suffix.length)
      : currentEmail;
    this.setData({
      emailEditorVisible: true,
      emailDraft: draft,
      emailEditWorkMode: workMode,
      emailEditSuffix: suffix,
      emailEditError: '',
    });
  },

  closeEmailEditor() {
    if (this.data.emailUpdating) return;
    this.setData({
      emailEditorVisible: false,
      emailEditError: '',
    });
  },

  stopPropagation() {},

  onEmailDraftInput(event) {
    this.setData({
      emailDraft: event.detail.value,
      emailEditError: '',
    });
  },

  validateEmailTypeForUpdate(email) {
    const payload = this.data.submittedPayload;
    if (!payload || Number(payload.emailstatus) !== 1) return '';

    const suffixes = String(this.data.emailSuffix || '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (!suffixes.length && payload.email && payload.email.indexOf('@') >= 0) {
      suffixes.push(payload.email.slice(payload.email.indexOf('@')).toLowerCase());
    }

    const normalizedEmail = email.toLowerCase();
    const matchesWorkEmail = suffixes.some((suffix) => {
      const normalizedSuffix = suffix.indexOf('@') >= 0
        ? suffix.slice(suffix.indexOf('@'))
        : `@${suffix}`;
      return normalizedEmail.endsWith(normalizedSuffix);
    });
    return matchesWorkEmail ? '' : '当前资料按工作邮箱提交，请输入学校工作邮箱';
  },

  async resendActivationEmail(email) {
    const payload = this.data.submittedPayload;
    const identityMetadata = this.data.submittedIdentity;
    if (this.data.registrationStatus !== 'unactivated'
      || !isTrustedIdentity(payload, identityMetadata)
      || payload.mobifile !== this.getCachedRegisterPhone()) {
      this.setData({ canModifyEmail: false, emailResendWarning: UNTRUSTED_REGISTRATION_MESSAGE });
      throw new Error(UNTRUSTED_REGISTRATION_MESSAGE);
    }

    const nextPayload = Object.assign({}, payload, {
      email,
      emailstatus: Number(payload.emailstatus) === 1 ? 1 : 0,
      random: randomCode(),
    });
    const result = await api.addUser(nextPayload);
    if (!isSuccessfulSubmitResult(result)) {
      const backendMsg = result && typeof result === 'object'
        ? (result.message || result.msg || result.error || '')
        : '';
      throw new Error(backendMsg ? mapBackendError(backendMsg) : '激活邮件发送失败，请稍后重试');
    }

    this.savePendingRegistration(nextPayload, email, identityMetadata);
    this.setData({
      submittedPayload: nextPayload,
      registrationStatus: 'unactivated',
      canModifyEmail: true,
    });
    return true;
  },

  async confirmEmailUpdate() {
    if (this.data.emailUpdating) return;

    const draft = this.data.emailDraft.trim();
    if (!draft) {
      this.setData({
        emailEditError: '请输入新邮箱',
      });
      return;
    }
    if (this.data.emailEditWorkMode && draft.indexOf('@') >= 0) {
      this.setData({ emailEditError: '请只输入邮箱前缀' });
      return;
    }
    if (this.data.emailEditWorkMode && !this.data.emailEditSuffix) {
      this.setData({ emailEditError: '学校邮箱后缀获取失败，请重新进入注册流程' });
      return;
    }
    const email = this.data.emailEditWorkMode
      ? `${draft}${this.data.emailEditSuffix}`
      : draft;
    if (!isEmail(email)) {
      this.setData({ emailEditError: '邮件格式不正确' });
      return;
    }
    if (email.toLowerCase() === this.data.successEmail.trim().toLowerCase()) {
      this.setData({ emailEditError: '请输入与当前邮箱不同的新邮箱' });
      return;
    }
    const emailTypeError = this.validateEmailTypeForUpdate(email);
    if (emailTypeError) {
      this.setData({ emailEditError: emailTypeError });
      return;
    }

    this.setData({ emailUpdating: true, emailEditError: '' });
    try {
      const currentStatus = await this.refreshRegistrationStatus({ silent: true });
      if (currentStatus === 'unknown') {
        this.setData({ emailEditError: '暂时无法确认注册状态，请稍后重试' });
        return;
      }
      if (currentStatus !== 'unactivated') {
        if (currentStatus === 'reviewing' || currentStatus === 'approved') {
          wx.showToast({ title: '注册状态已更新', icon: 'none' });
        }
        return;
      }

      const occupiedError = await this.checkEmailOccupied(
        email,
        '该邮箱已注册，请输入一个未注册的新邮箱',
      );
      if (occupiedError) {
        this.setData({ emailEditError: occupiedError });
        return;
      }

      await this.resendActivationEmail(email);
      this.setData({
        successEmail: email,
        emailEditorVisible: false,
        emailDraft: '',
      });
      wx.showToast({
        title: '邮件已重新发送',
        icon: 'success',
      });
    } catch (err) {
      this.setData({ emailEditError: (err && err.message) || '修改失败，请稍后重试' });
    } finally {
      this.setData({ emailUpdating: false });
    }
  },
});
