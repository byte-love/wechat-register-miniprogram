Page({
  goPrivacy() {
    wx.navigateTo({ url: '/pages/agreement/privacy' });
  },

  acknowledge() {
    wx.navigateBack({ delta: 1 });
  },
});
