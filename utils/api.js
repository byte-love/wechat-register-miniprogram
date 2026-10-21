const {
  request,
  uploadFile,
  joinUrl,
} = require('./request');
const { deliveryMock } = require('./config');

function encode(value) {
  return encodeURIComponent(value == null ? '' : value);
}

module.exports = {
  searchInstitutions(search) {
    return request({ url: `/api/userAuth/searchInstitutions?search=${encode(search)}` });
  },
  getIpAddr(address) {
    return request({ url: `/api/userAuth/getIpAddr?address=${encode(address)}&time=${Date.now()}` });
  },
  validPhoneForRegister(tel) {
    return request({ url: `/api/userAuth/VaildPhoneForRegiest?tel=${encode(tel)}`, method: 'POST' });
  },
  sendMessage(tel) {
    return request({ url: `/api/userAuth/sendMessage?tel=${encode(tel)}`, method: 'POST' });
  },
  validCode(tel, code) {
    return request({ url: `/api/userAuth/VaildCode?tel=${encode(tel)}&code=${encode(code)}`, method: 'POST' });
  },
  uploadRegisterFile(filePath) {
    return uploadFile('/api/userAuth/uploadRegisterFile', filePath);
  },
  uploadDeliveryFile(filePath) {
    return uploadFile('/test-api/userAuth/uploadRegisterFile', filePath);
  },
  getRegisterEmail(email, baseIPA) {
    return request({ url: `/api/userAuth/getWeChatEmail?email=${encode(email)}&baseIPA=${encode(baseIPA)}` });
  },
  getRegistrationStatus(tel) {
    return request({ url: `/api/userAuth/getRegisterStatus?tel=${encode(tel)}`, method: 'POST' });
  },
  validateStudentNo(studentNo, school) {
    return request({ url: `/api/userAuth/validateStudentNo?stduentNo=${encode(studentNo)}&school=${encode(school)}` });
  },
  addUser(data) {
    return request({ url: '/api/userAuth/wechatAddUser', method: 'POST', data });
  },
  activateAccount(data) {
    return request({ url: '/api/userAuth/activateWechatAccount', method: 'POST', data });
  },

  // 微信手机号 code 换号（统一走 api-test.example.com 后端）
  exchangePhone(code) {
    return request({ url: '/api/register/phone/exchange', method: 'POST', data: { code }, header: { 'content-type': 'application/json' } });
  },

  // 获取 DataHub 平台数据使用协议 PDF
  getDataHubAgreementPDF(address, version) {
    return request({ url: `/api/Home/GetDataHubAgreementPDF?address=${encode(address)}&version=${encode(version)}` });
  },

  // 获取注册信息文档 URL
  getAllMessageDocUrl() {
    return joinUrl(`/api/Home/AllMessageDoc`);
  },

  // ===== 数据交付申请 =====
  // 后端 datahub 项目接口，统一 R 包装体 {code:200, message, data:{...}}。
  // 这里负责「解包」：把 data 层交给已验收的 confirm-apply 页（它直读 res.account / 判 res===true）。
  //
  // 按 id 查申请详情（账户 + 申请的数据库列表）。
  getDeliveryApply(id) {
    if (deliveryMock) {
      return Promise.resolve({ account: 'test001', databases: ['上市公司财务库', '债券库', '基金库'] });
    }
    return request({ url: `/api/delivery/detail?id=${encode(id)}` }).then((res) => {
      // 成功码 200，数据在 res.data；否则抛出 message 让页面进 error 视图
      if (res && res.code === 200 && res.data) {
        return res.data;
      }
      throw new Error((res && res.message) || '未找到该申请记录');
    });
  },

  // 用户确认申请信息无误。成功时 resolve(true) 对齐页面判断。
  confirmDeliveryApply(id, protocolUrl) {
    if (deliveryMock) {
      return Promise.resolve(true);
    }
    return request({ url: '/api/delivery/confirm', method: 'POST', data: { id, protocolUrl } }).then((res) => {
      if (res && res.code === 200) {
        return true;
      }
      throw new Error((res && res.message) || '确认失败，请稍后重试');
    });
  },
};