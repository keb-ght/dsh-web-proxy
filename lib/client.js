// dsh-web-proxy —— 浏览器半区：在「设置」左侧导航注册「反代」一节
// 内容复用反代自带的管理界面（同机 iframe），token 走 /health 自动取，用户不用手输。
window.__ModuleLoader__.load({
  id: 'dsh-web-proxy',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = null;
    try { React = require('react'); } catch (e) { React = null; }

    var PORTS = [8787, 8788, 8789, 8790, 8791, 8792];
    var PORT = 8787;
    var BASE = 'http://127.0.0.1:' + PORT;

    // 插件可能在 8787 被占时顺延，这里逐个探测
    function probe() {
      var i = 0;
      function next() {
        if (i >= PORTS.length) return Promise.resolve(null);
        var p = PORTS[i++];
        return fetch('http://127.0.0.1:' + p + '/health', { cache: 'no-store' })
          .then(function (r) { return r.json() })
          .then(function (d) { return (d && d.ok) ? { port: p, token: d.adminToken || '' } : next() })
          .catch(next);
      }
      return next();
    }

    function Section() {
      if (!React) return null;
      var h = React.createElement;
      var st = React.useState(''); var token = st[0]; var setToken = st[1];
      var s2 = React.useState(false); var ready = s2[0]; var setReady = s2[1];
      var s3 = React.useState(0); var tick = s3[0]; var setTick = s3[1];
      var s4 = React.useState(8787); var portNow = s4[0]; var setPort = s4[1];

      React.useEffect(function () {
        var alive = true;
        probe().then(function (hit) {
          if (!alive) return;
          if (hit) {
            setPort(hit.port);
            if (hit.token) { try { localStorage.setItem('ds_admin_token', hit.token) } catch (e) {} setToken(hit.token) }
            setReady(true);
          } else {
            setReady(true);
          }
        }).catch(function () { if (alive) setReady(true) });
        return function () { alive = false };
      }, [tick]);

      var base = 'http://127.0.0.1:' + portNow;
      var src = base + '/admin' + (token ? '?token=' + encodeURIComponent(token) : '');
      var open = React.createElement('a', {
        href: 'http://127.0.0.1:' + portNow + '/admin', target: '_blank', rel: 'noreferrer',
        style: { fontSize: 13, textDecoration: 'underline', whiteSpace: 'nowrap' },
      }, '新窗口打开');

      if (!ready) {
        return h('div', { style: { padding: 16, fontSize: 13, opacity: 0.7 } }, '正在连接反代…');
      }
      if (!token) {
        return h('div', { style: { padding: 16, fontSize: 13 } },
          h('div', { style: { marginBottom: 8 } }, '连不上反代服务（已试 8787–8792）。插件可能没启动成功，或端口都被占。'),
          h('button', { onClick: function () { setTick(tick + 1) }, style: { fontSize: 13, padding: '6px 12px', borderRadius: 8, cursor: 'pointer' } }, '重试'),
          h('span', { style: { marginLeft: 12, opacity: 0.6 } }, open),
        );
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h('div', { style: { fontSize: 13, opacity: 0.72 } },
            '反代服务 ' + base + ' · 账号池 / 冷却 / 模型映射 / 日志都在下面'),
          h('div', { style: { display: 'flex', gap: 14 } },
            h('button', { onClick: function () { setTick(tick + 1) }, style: { fontSize: 13, padding: '4px 10px', borderRadius: 8, cursor: 'pointer' } }, '刷新'),
            open,
          ),
        ),
        h('iframe', {
          key: token,
          src: src,
          title: 'DS Web Proxy',
          style: {
            width: '100%', height: '72vh', minHeight: 520,
            border: '1px solid rgba(127,127,127,0.25)', borderRadius: 14,
            background: '#0c0d10', display: 'block',
          },
        }),
      );
    }

    function apply(ctx) {
      // 任何异常都不允许冒到宿主：client 插件抛错会让整个 Web shell 白屏
      try {
        if (!ctx || !ctx.slots || !ctx.slots.inject || !ctx.slots.register) return;
        ctx.slots.inject('settings.section', function () {
          try {
            return ctx.slots.register({ name: 'settings.section', id: 'web-proxy', order: 40, label: '反代' }, Section);
          } catch (e) { return undefined; }
        });
      } catch (e) {
        try { console.warn('[dsh-web-proxy] settings section 注册失败：', e && e.message); } catch (_) {}
      }
    }

    exports.apply = apply;
    // 客户端注入：必须声明 slots，否则 ctx.slots 不存在、设置节注册不上
    exports.inject = ['slots'];
    exports.Section = Section;
    return module.exports;
  },
});
