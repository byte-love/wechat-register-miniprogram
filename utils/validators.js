function isPhone(value) {
  return /^1\d{10}$/.test(String(value || '').trim());
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function randomCode() {
  let text = '';
  while (text.length < 16) text += Math.random().toString(36).slice(2);
  return text.slice(0, 16);
}

module.exports = {
  isPhone,
  isEmail,
  randomCode,
};
