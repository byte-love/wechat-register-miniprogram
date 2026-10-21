const config = {
  // 生产环境地址：注册相关正式接口统一走 api.example.com。
  // 保证稳定接口指向外网
   baseUrl: 'https://api.example.com',
  //baseUrl: 'http://127.0.0.1:8020',

  // 测试环境地址：数据交付确认页及其他测试中接口统一走 api-test.example.com。
  // 指向测试环境
  testbaseUrl: 'https://api-test.example.com',
  //testbaseUrl: 'http://127.0.0.1:8020',

  // 注册状态接口已接入。
  registrationStatusEnabled: true,

  // 数据交付申请确认页 mock 开关：true 时不发网络请求、用本地假数据跑通全流程，
  // 便于后端接口就绪前预览/测试；联调与上线前务必置 false。
  // ⚠️【数据交付本地联调临时改动 2026-09-01】原为 true，为走真后端改成 false。联调后可视情况改回。
  deliveryMock: false,
};

module.exports = config;