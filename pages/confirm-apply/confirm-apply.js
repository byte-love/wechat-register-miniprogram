const api = require('../../utils/api');

Page({
  data: {
    step: 'loading',   // loading / confirm / success / error
    id: '',
    account: '',
    nickName: '',
    school: '',
    email: '',
    phone: '',
    responsiblePerson: '',
    databases: [],
    submitting: false,
    submitError: '',
    errorMsg: '',
    protocolFileName: '',
    protocolImgUrl: '',
    rejectReason: '',
    rejectReasonFull: '',
    rejectReasonOverflow: false,
    rejectReasonExpanded: false,
    isConfirmed: false,
  },

  onLoad(options) {
    // 兼容两种二维码形态：
    //   小程序码(wxacode) → options.scene（URL 编码，≤32 字符，通常就是 id）
    //   普通 URL / scheme → options.id
    let id = '';
    if (options && options.scene) {
      try {
        id = decodeURIComponent(options.scene);
      } catch (e) {
        id = options.scene;
      }
    } else if (options && options.id) {
      id = options.id;
    }

    id = String(id || '').trim();
    if (!id) {
      this.setData({ step: 'error', errorMsg: '未获取到申请编号，请通过管理员提供的二维码重新进入。' });
      return;
    }

    this.setData({ id });
    this.loadApply(id);
  },

  loadApply(id) {
    api.getDeliveryApply(id)
      .then((res) => {
        // 字段名以后端返回为准，届时按后端拼写对齐
        const account = res && (res.account || res.userName || res.username) || '';
        const nickName = res && (res.nickName || res.name) || '';
        const school = res && res.school || '';
        const email = res && res.email || '';
        const phone = res && res.phone || '';
        const responsiblePerson = res && (res.responsiblePerson || res.responsible || res.giver) || '';
        const databases = (res && (res.databases || res.dbList || res.dbs)) || [];
        const databaseList = Array.isArray(databases) ? databases : [];
        if (!account && !nickName && !school && !email && !phone && !responsiblePerson && databaseList.length === 0) {
          this.setData({ step: 'error', errorMsg: '未找到该申请记录，或申请已被处理。' });
          return;
        }
        const status = (res && res.status) ? String(res.status).toUpperCase() : 'PENDING';
        const rejectReason = (res && (res.rejectReason || res.remark || res.auditMessage || res.reason)) || '';

        // 说明超过 57 字就截断（约三行），由页面上的"...展开"来控制是否显示全文
        const REJECT_REASON_MAX = 57;
        const rejectReasonOverflow = rejectReason.length > REJECT_REASON_MAX;

        // PENDING (待确认)
        // CONFIRMED (已确认, 蓝灰)
        // APPROVED (审批通过, 绿)
        // REJECTED (审批拒绝, 红)
        const isConfirmed = status === 'CONFIRMED' || status === 'APPROVED' || status === 'REJECTED';

        this.setData({
          step: 'confirm',
          account,
          nickName,
          school,
          email,
          phone,
          responsiblePerson,
          databases: databaseList,
          isConfirmed,
          applyStatus: status,
          rejectReason: rejectReasonOverflow ? rejectReason.slice(0, REJECT_REASON_MAX) : (rejectReason || '无'),
          rejectReasonFull: rejectReason || '无',
          rejectReasonOverflow,
          rejectReasonExpanded: false,
        });
      })
      .catch((err) => {
        this.setData({ step: 'error', errorMsg: (err && err.message) || '加载申请信息失败，请稍后重试。' });
      });
  },

  
  chooseProtocolImage() {
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles[0];
        const filePath = file.path;
        
        // 校验图片格式
        const normalizedPath = String(filePath || '').split(/[?#]/)[0].toLowerCase();
        if (!/.(jpg|jpeg|png)$/.test(normalizedPath)) {
          wx.showToast({ title: '仅支持 JPG/PNG 格式', icon: 'none' });
          return;
        }

        // 校验大小 (8M)
        if (file.size > 8 * 1024 * 1024) {
          wx.showToast({ title: '图片不能大于8M', icon: 'none' });
          return;
        }

        wx.showLoading({ title: '上传中', mask: true });
        api.uploadDeliveryFile(filePath)
          .then(uploadRes => {
            wx.hideLoading();
            // 直接读取标准的格式： { code: 200, message: '成功', data: { url: '...' } }
            if (uploadRes && uploadRes.data && uploadRes.data.url) {
              const url = uploadRes.data.url;
              let name = '已上传图片';
              const parts = url.split('/');
              if (parts.length > 0) name = parts[parts.length - 1];

              this.setData({
                protocolImgUrl: url,
                protocolFileName: name,
                submitError: ''
              });
              wx.showToast({ title: '上传成功', icon: 'success' });
            } else {
              throw new Error('返回数据异常: 未找到 data.url');
            }
          })
          .catch(err => {
            wx.hideLoading();
            console.error('上传失败:', err);
            wx.showToast({ title: '上传失败', icon: 'none' });
          });
      }
    });
  },

  // 点击"...展开/收起"：切换完整说明
  toggleRejectReason() {
    if (!this.data.rejectReasonOverflow) return;
    this.setData({ rejectReasonExpanded: !this.data.rejectReasonExpanded });
  },

  confirmApply() {
    if (this.data.submitting) return;

    // 未上传协议图片时拦截：已拒绝状态按钮文案已说明，不再提示；其他状态给出 toast
    if (!this.data.protocolImgUrl) {
      if (this.data.applyStatus !== 'REJECTED') {
        wx.showToast({ title: '请先上传《数据库赠送使用协议》', icon: 'none' });
      }
      return;
    }

    this.setData({ submitting: true, submitError: '' });

    api.confirmDeliveryApply(this.data.id, this.data.protocolImgUrl)
      .then((res) => {
        if (res === true || res === 'true' || (res && (res.success === true || res.data === true))) {
          this.setData({ step: 'success', submitting: false });
        } else {
          this.setData({ submitting: false, submitError: (res && (res.message || res.msg)) || '确认失败，请稍后重试。' });
        }
      })
      .catch((err) => {
        this.setData({ submitting: false, submitError: (err && err.message) || '确认失败，请稍后重试。' });
      });
  },
});
