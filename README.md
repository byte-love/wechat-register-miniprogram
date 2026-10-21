# DataHub 注册小程序

原生微信小程序注册流程，单页应用以注册表单为主，另含数据交付申请确认页。

## 如何运行

1. 安装微信开发者工具
2. 导入本项目目录
3. 本地调试时可在开发者工具里关闭"校验合法域名"
4. 当前代码正式功能配置已指向 `https://api.example.com`，数据交付及测试功能指向 `https://api-test.example.com`

当前用测试 AppID `wx0000000000000000`；正式上线需换成真实 AppID，并在小程序后台配置合法域名。

## 注册流程

1. 身份选择、学校搜索/资格校验 — `/api/userAuth/searchInstitutions`、`/api/userAuth/getIpAddr`；学校返回的 Role 字段不覆盖用户所选身份
2. 手机号验证 — `VaildPhoneForRegiest`、`sendMessage`、`VaildCode`
3. 按第一步所选身份展示资料字段 — 教师 / 在读博士生 / 其他研究人员；其他研究人员在此选择具体子身份
4. 资料填写 + 图片上传 — `uploadRegisterFile`（证件照和协议照，经过正式环境路由到 `/api/userAuth/uploadRegisterFile`）
5. 占用校验 — 手机号与邮箱检查；`validateStudentNo` 仅在 API 清单中定义，当前注册页面未调用
6. 提交 — `wechatAddUser`
7. **激活与进度** — 后端发送激活邮件，用户在邮箱点击链接；小程序成功页查询注册状态，未激活且缓存身份可验证时可修改邮箱并请求重发。教师在进入数据使用协议页前已提交，协议确认阶段复用原快照，不重复提交

另有数据交付申请确认页 `pages/confirm-apply`，凭申请 id 拉取详情并执行确认；是否走假数据由 `config.js` 的 `deliveryMock` 控制。

## 技术栈与目录

- **无构建**：纯小程序原生框架，所有文件直接运行
- **pages/register/** — 注册表单主页面：WXML、WXSS、JS、JSON
- **pages/confirm-apply/** — 数据交付申请确认页
- **pages/agreement/** — 用户服务协议、隐私政策两个静态页
- **utils/** — 网络层（request.js）、接口定义（api.js）、配置（config.js）、校验器（validators.js）
- **app.*** — 小程序全局配置和样式

关键实现细节：`utils/request.js` 维护 Cookie 跨请求传递，让依赖 Session 的验证码校验能正常工作；路由逻辑会将 `/api/delivery/*` 以及 `/test-api/*`（后者会重写回 `/api/` 前缀）分配到 `testbaseUrl`，其他所有 `/api/*` 默认路由到正式环境 `baseUrl`，**不会去掉 `/api` 前缀**。

## 接口域名配置

在 [utils/config.js](utils/config.js) 里：

```js
baseUrl: 'https://api.example.com', // 注册等正式功能
testbaseUrl: 'https://api-test.example.com', // 数据交付等正在测试的功能
deliveryMock: false,
```

当前配置注册正式入口为 `https://api.example.com`，数据交付及测试功能为 `https://api-test.example.com`，发布正式版前应再次核对正式 AppID、合法域名和后端部署版本。

## 当前状态

以下为截至 2026-09-10 的本地实现状态，不代表生产部署或真机验收：

- 注册接口、三类身份动态字段、协议勾选跳转、短信验证和文档下载已接入
- Cookie 跨请求维护已实现；生产验证码 Session 链路仍需联调核验
- 数据交付申请确认页已接入 `/api/delivery/detail`、`/api/delivery/confirm`，`deliveryMock: false`
- 注册状态查询已启用，成功页修改邮箱复用 `wechatAddUser` 请求重新发送激活邮件；生产接口和邮件实际送达尚未核验
- 生产扫码依赖包含 `pages/confirm-apply` 的正式版小程序和后端数据交付路由/免登录修复；既有联调记录中二维码使用 `env_version=release`，发布时需重新确认
- 既有联调记录中上传接口返回 `100503 请先登录`；是否已修复待后端核验
- 激活邮件链接由后端生成，生产外网域名仍待确认

## 身份与重发缓存合同

小程序提交 `wechatAddUser` 时，三个身份参数统一为**数字 `0/1`**；本地缓存校验不接受布尔值或字符串。根据本地 Java 后端，`bo` 写入数据库 `isdoctor`，`bos` 写入 `isdoctorteach`，`isotheruser` 写入同名字段；请求不另传 DTO 未接收的 `isdoctor`、`isdoctorteach`，不是删除数据库字段。生产部署是否使用同版映射仍需核验。

| 表单身份 | `bo` | `bos` | `isotheruser` | `OtherUserIdentity` |
|---|---|---|---|---|
| `Doctor`（在读博士生） | 1 | 0 | 0 | 空字符串 |
| `Teacher`（教师） | 0 | 1 | 0 | 空字符串 |
| `Other`（其他研究人员） | 0 | 0 | 1 | 子身份中文标签 |

子身份映射：`shuoshiidentity` → 在读硕士生；`benkeidentity` → 在读本科生；`otheridentity` → 其他工作人员。其他研究人员在资料步骤必须选择合法子身份；非法身份不可提交，教师/博士的残留子身份不写入请求。

成功提交缓存 `identityMetadata: { version: 1, identity, subIdentity }`。重发要求元数据版本、身份字段及子身份严格匹配，并且 `payload.mobifile` 与缓存手机号一致。缺少元数据的旧缓存、布尔/字符串身份字段、旧字段残留或手机号不符的缓存一律禁止修改邮箱重发，但仍保留状态查询和已有邮箱显示，并提示使用原激活邮件或联系客服；不能根据旧字段猜测身份迁移。

## 短信发送判定

手动手机号验证的 `sendCode` 调用 `sendMessage`，从字符串响应或对象 `message/msg/error` 取提示；去掉首尾空白后只有严格等于 `OK` 才显示已发送并开始 60 秒倒计时。HTTP 200、布尔成功值或未知响应不能视为短信成功。包含“流控 / 限流 / 频繁 / Permits”的响应显示稍后重试，包含“小时”时提示每小时上限；失败不启动倒计时，也不在前端绕过供应商限制。

## 注册状态接口约定

成功提交后，小程序缓存手机号和待激活注册参数。再次进入时请求：

```text
POST /api/userAuth/getRegisterStatus?tel=手机号
```

前端按以下纯文本状态映射（生产返回仍待核验，代码另有对象/英文状态兼容）：

- 手机号未注册：清理失效缓存并回到学校步骤
- 未激活：停留在成功页，仅身份缓存可信时显示修改邮箱按钮
- 待审核：停留在成功页并隐藏修改邮箱按钮
- 驳回：显示注册申请未通过完成页，点击重新注册后清理缓存并回到学校步骤
- 审核通过，待开通：显示审核通过、账号正在开通中的状态页，并继续检查开通结果
- 手机号接口返回已被绑定：显示账号已注册完成页，点击完成后清理缓存并回到学校步骤

接口异常和未知状态沿用本地缓存的最近状态。

非静默状态查询期间隐藏修改邮箱按钮，用户确认修改邮箱前再次查询状态；查询异常或未知状态不允许本次修改继续。待审核、审核通过待开通、驳回或已注册时，本地缓存移除完整注册参数、身份元数据及学校邮箱后缀，仅保留手机号、邮箱和状态。成功页每 5 秒轮询，驳回/已注册停止轮询。

原注册资料按工作邮箱提交时，新邮箱继续校验学校邮箱后缀并保持 `emailstatus: 1`；原注册资料按个人邮箱提交时保持 `emailstatus: 0`。

`utils/config.js` 中的 `registrationStatusEnabled` 已设为 `true`。

## 离线验证

在项目根目录运行（仅需 Node.js，无需安装依赖）：

```bash
node tests/register-identity.test.js
```

该回归测试通过模拟 `wx.request` 验证五种身份/子身份提交及重发、教师预提交快照、防止无效身份请求、旧缓存禁重发和状态迁移清理，不发送真实注册或短信请求。短信限流分支当前不在此测试覆盖内；微信开发者工具重新编译、真机界面及生产邮件/状态链路须另行验证。

