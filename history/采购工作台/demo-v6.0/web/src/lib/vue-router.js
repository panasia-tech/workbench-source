/**
 * 轻量级 Vue 3 Hash 路由引擎（完全兼容 vue-router API 子集：动态参数、beforeEach 守卫、router-link/router-view）
 */
import { reactive, shallowRef, inject, computed, h, defineComponent } from 'vue';

const ROUTER_KEY = Symbol('panasia_router');
const ROUTE_KEY = Symbol('panasia_route');

export function createWebHashHistory() {
  return { mode: 'hash' };
}

function parseHashTarget(raw) {
  let s = String(raw || '').trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (!s.startsWith('/')) s = `/${s}`;
  const qIdx = s.indexOf('?');
  const path = qIdx >= 0 ? s.slice(0, qIdx) : s;
  const queryStr = qIdx >= 0 ? s.slice(qIdx + 1) : '';
  const query = {};
  if (queryStr) {
    for (const [k, v] of new URLSearchParams(queryStr).entries()) {
      query[k] = v;
    }
  }
  return { path: path || '/', query, fullPath: `${path || '/'}${queryStr ? `?${queryStr}` : ''}` };
}

function matchRoute(routes, path) {
  const cleanSegs = path.split('/').filter(Boolean);
  for (const r of routes) {
    const rSegs = String(r.path || '/').split('/').filter(Boolean);
    if (rSegs.length !== cleanSegs.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < rSegs.length; i += 1) {
      if (rSegs[i].startsWith(':')) {
        params[rSegs[i].slice(1)] = decodeURIComponent(cleanSegs[i]);
      } else if (rSegs[i] !== cleanSegs[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { routeRec: r, params };
  }
  return { routeRec: routes.find((r) => r.path === '/') || routes[0], params: {} };
}

export function createRouter({ routes = [] }) {
  const guards = [];
  const currentComp = shallowRef(null);
  const currentRoute = reactive({
    path: '/',
    fullPath: '/',
    params: {},
    query: {},
    meta: {},
  });

  function applyTarget(target, updateHash = false) {
    let parsed = parseHashTarget(target);
    let { routeRec, params } = matchRoute(routes, parsed.path);
    const candidateTo = { path: parsed.path, fullPath: parsed.fullPath, params, query: parsed.query, meta: routeRec?.meta || {} };

    for (const fn of guards) {
      const res = fn(candidateTo, currentRoute);
      if (typeof res === 'string' && res !== parsed.path) {
        parsed = parseHashTarget(res);
        const re = matchRoute(routes, parsed.path);
        routeRec = re.routeRec;
        params = re.params;
        break;
      }
      if (res === false) return;
    }

    currentRoute.path = parsed.path;
    currentRoute.fullPath = parsed.fullPath;
    currentRoute.params = params;
    currentRoute.query = parsed.query;
    currentRoute.meta = routeRec?.meta || {};
    currentComp.value = routeRec?.component || null;

    if (updateHash && typeof window !== 'undefined') {
      const nextHash = `#${parsed.fullPath}`;
      if (window.location.hash !== nextHash) {
        window.location.hash = nextHash;
      }
    }
  }

  function push(to) {
    const raw = typeof to === 'string' ? to : to?.path || '/';
    applyTarget(raw, true);
  }

  function replace(to) {
    push(to);
  }

  function beforeEach(fn) {
    if (typeof fn === 'function') guards.push(fn);
  }

  const router = {
    beforeEach,
    push,
    replace,
    currentRoute,
    install(app) {
      app.provide(ROUTER_KEY, router);
      app.provide(ROUTE_KEY, currentRoute);

      if (typeof window !== 'undefined') {
        window.addEventListener('hashchange', () => {
          applyTarget(window.location.hash || '#/', false);
        });
        applyTarget(window.location.hash || '#/', true);
      }

      const RouterLink = defineComponent({
        name: 'RouterLink',
        props: { to: { type: [String, Object], required: true } },
        setup(props, { slots }) {
          const targetStr = computed(() => (typeof props.to === 'string' ? props.to : props.to?.path || '/'));
          const isActive = computed(() => {
            const toPath = parseHashTarget(targetStr.value).path;
            return currentRoute.path === toPath || (toPath !== '/' && currentRoute.path.startsWith(`${toPath}/`));
          });
          return () =>
            h(
              'a',
              {
                href: `#${targetStr.value}`,
                class: isActive.value ? 'router-link-active' : undefined,
                onClick: (e) => {
                  e.preventDefault();
                  push(targetStr.value);
                },
              },
              slots.default ? slots.default() : []
            );
        },
      });

      const RouterView = defineComponent({
        name: 'RouterView',
        setup() {
          return () => (currentComp.value ? h(currentComp.value) : null);
        },
      });

      app.component('RouterLink', RouterLink);
      app.component('router-link', RouterLink);
      app.component('RouterView', RouterView);
      app.component('router-view', RouterView);
    },
  };

  return router;
}

export function useRouter() {
  return inject(ROUTER_KEY);
}

export function useRoute() {
  return inject(ROUTE_KEY);
}
