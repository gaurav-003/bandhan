// Bandhan — set-password page logic. Token URL se aata hai (confirm redirect).
(function () {
  var params = new URLSearchParams(window.location.search);
  var token = params.get('setToken') || '';
  var email = params.get('email') || '';
  var msg = document.getElementById('msg');
  var sub = document.getElementById('sub');
  var form = document.getElementById('pwform');

  if (email) {
    sub.textContent = 'Email ' + email + ' confirm ho gaya. Ab apna password set karo.';
  }
  if (!token) {
    msg.textContent = 'Ye link valid nahi hai — dobara confirmation mail mangwao.';
    msg.className = 'err';
    form.style.display = 'none';
    return;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var pw = document.getElementById('pw').value;
    var pw2 = document.getElementById('pw2').value;
    if (pw.length < 8) {
      msg.textContent = 'Password kam se kam 8 characters ka hona chahiye.';
      msg.className = 'err';
      return;
    }
    if (pw !== pw2) {
      msg.textContent = 'Dono passwords same nahi hain.';
      msg.className = 'err';
      return;
    }
    msg.textContent = 'Saving...';
    msg.className = '';
    fetch('/api/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setToken: token, password: pw })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          msg.textContent = res.d.error || 'Kuch gadbad ho gayi — dobara try karo.';
          msg.className = 'err';
          return;
        }
        form.style.display = 'none';
        sub.textContent = 'Welcome to Bandhan, ' + (res.d.user && res.d.user.firstName ? res.d.user.firstName : '') + '!';
        msg.textContent = 'Account ready! Ab tum Bandhan website pe login kar sakte ho.';
        msg.className = 'ok';
      })
      .catch(function () {
        msg.textContent = 'Network error — dobara try karo.';
        msg.className = 'err';
      });
  });
})();
