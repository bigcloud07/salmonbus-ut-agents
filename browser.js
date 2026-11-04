import { setTimeout as delay } from "node:timers/promises";

export const production = "https://www.salmonbus.com";
export const viewport = { width: 390, height: 844 };

const kakaoStart = "/api/auth/kakao/start";
const kakaoCallback = "/api/auth/kakao/callback";
const sessionPath = "/api/auth/session";
const tapLabelLimit = 80;

function tapElement(element) {
  if (typeof element?.tag !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(element.tag)) return null;
  const bounded = (value, limit) => typeof value === "string"
    ? value.slice(0, limit).replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim()
    : "";
  return { tag: element.tag, role: bounded(element.role, 40), text: bounded(element.text, tapLabelLimit) };
}

function authPath(path) {
  return /^\/(?:api\/auth|oauth2|login\/oauth2)(?:\/|$)/i.test(path);
}

function safeReturnTo(url, origin) {
  const value = url.searchParams.get("returnTo");
  const target = new URL(value?.startsWith("/") ? value : "/", origin);
  return target.origin === origin && !authPath(target.pathname) ? target : new URL("/", origin);
}

function publicPath(url) {
  const { pathname, searchParams } = new URL(url);
  const query = new URLSearchParams();
  for (const key of ["direction", "stopId"]) {
    const value = searchParams.get(key);
    if (/^(?:UP|DOWN|\d{1,18})$/.test(value ?? "")) query.set(key, value);
  }
  return query.size ? `${pathname}?${query}` : pathname;
}

export function validateAction(step) {
  const coordinate = (value, limit) => Number.isInteger(value) && value >= 0 && value < limit;
  if (typeof step?.remark !== "string" || !["tap", "input", "scroll", "back", "stop"].includes(step.action)) {
    throw new Error("모델이 지원하지 않는 조작을 반환했습니다.");
  }
  const { action, x, y, text, deltaY, submit } = step;
  if (["tap", "scroll"].includes(action) && (!coordinate(x, viewport.width) || !coordinate(y, viewport.height))) {
    throw new Error("모델이 화면 밖 좌표를 반환했습니다.");
  }
  if (action === "scroll" && (!Number.isInteger(deltaY) || deltaY === 0 || Math.abs(deltaY) > viewport.height)) {
    throw new Error("모델이 허용 범위 밖의 스크롤을 반환했습니다.");
  }
  if (action === "input" && (typeof text !== "string" || text.length > 80 || /[\u0000-\u001f]/.test(text) || typeof submit !== "boolean")) {
    throw new Error("모델이 허용 범위 밖의 입력을 반환했습니다.");
  }
  return step;
}

export async function openSession(browser, {
  origin = production,
  localAuth = false,
  authTimeout = 120_000,
  onHandoff = () => console.log("브라우저에서 카카오 인증을 진행해 주세요. 연어로 돌아오면 이어서 진행합니다."),
} = {}) {
  if (origin !== production && !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("허용되지 않은 테스트 주소입니다.");
  if (localAuth && origin === production) throw new Error("운영에서는 인증을 시작할 수 없습니다.");

  const context = await browser.newContext({
    viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 1, locale: "ko-KR",
    timezoneId: "Asia/Seoul", serviceWorkers: "block", acceptDownloads: false,
  });
  let authAttempt;
  let authInProgress = false;
  let authUnsafe = false;
  try {
    await context.routeWebSocket("**/*", socket => socket.close());
    await context.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      const read = ["GET", "HEAD"].includes(request.method());
      let path;
      try {
        path = decodeURIComponent(url.pathname).replace(/\/{2,}/g, "/");
      } catch {
        return route.abort("blockedbyclient");
      }
      if (url.origin === origin) {
        if (path === kakaoStart && localAuth && read && request.isNavigationRequest() && !authInProgress) {
          authInProgress = true;
          authAttempt = waitForKakao(safeReturnTo(url, origin));
          onHandoff();
          return route.continue();
        }
        if (path === kakaoCallback && localAuth && read && authInProgress) return route.continue();
        if (authPath(path) && path !== sessionPath) {
          if (!localAuth && /\/start$/i.test(path)) authAttempt = Promise.resolve({ status: "not_run", waitMs: 0 });
          return route.abort("blockedbyclient");
        }
        return read ? route.continue() : route.abort("blockedbyclient");
      }
      const assetHost = /^(?:[\w-]+\.)*(?:naver\.com|naver\.net|pstatic\.net)$/.test(url.hostname)
        || ["fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname);
      return read && !request.isNavigationRequest() && url.protocol === "https:" && assetHost
        ? route.continue()
        : route.abort("blockedbyclient");
    });
  } catch (error) {
    await context.close();
    throw error;
  }

  const page = await context.newPage();
  let nextTapId = 0;
  let pendingTap;
  page.setDefaultTimeout(5_000);
  context.on("page", popup => { if (popup !== page) void popup.close().catch(() => {}); });
  page.on("dialog", dialog => void dialog.dismiss().catch(() => {}));
  try {
    await page.exposeBinding("recordUtTap", ({ frame }, id, target, interactive) => {
      if (!pendingTap || id !== pendingTap.id || frame !== page.mainFrame()) return;
      const url = new URL(frame.url());
      if (authInProgress || authUnsafe || url.origin !== origin || authPath(url.pathname)) return;
      pendingTap.resolve({ target: tapElement(target), interactive: tapElement(interactive) });
    });
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 10_000 });
  } catch (error) {
    await context.close();
    throw error;
  }

  async function waitForKakao(target) {
    const started = Date.now();
    let status = "failed";
    authUnsafe = true;
    try {
      const callback = await page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.origin === origin && url.pathname === kakaoCallback;
      }, { timeout: authTimeout });
      const location = callback.headers().location;
      if (!location) return { status, waitMs: Date.now() - started };
      const redirect = new URL(location, origin);
      if (redirect.origin !== origin || authPath(redirect.pathname)) return { status, waitMs: Date.now() - started };
      await page.waitForURL(url => url.origin === origin && !authPath(url.pathname)
        && url.pathname === redirect.pathname
        && [...redirect.searchParams].every(([key, value]) => key === "login" || url.searchParams.get(key) === value), {
        waitUntil: "domcontentloaded", timeout: Math.max(1, authTimeout - (Date.now() - started)),
      });
      authUnsafe = false;
      const result = redirect.searchParams.get("login");
      if (result === "cancelled") {
        status = "cancelled";
      } else if (!result && redirect.pathname === target.pathname
        && [...target.searchParams].every(([key, value]) => redirect.searchParams.get(key) === value)) {
        const response = await context.request.get(origin + sessionPath, { maxRedirects: 0, timeout: 5_000 });
        try {
          if (response.ok() && (await response.json()).authenticated === true) status = "authenticated";
        } finally {
          await response.dispose();
        }
      }
    } catch (error) {
      if (error.name === "TimeoutError") status = "timeout";
    } finally {
      authInProgress = false;
    }
    return { status, waitMs: Date.now() - started };
  }

  async function takeAuth() {
    const attempt = authAttempt;
    authAttempt = undefined;
    return attempt ? await attempt : undefined;
  }

  async function tap(x, y) {
    const id = ++nextTapId;
    const { promise, resolve } = Promise.withResolvers();
    pendingTap = { id, resolve };
    try {
      await page.evaluate(({ id, tapLabelLimit }) => {
        const editable = "input, textarea, select, [contenteditable]";
        const control = 'button, a[href], label, summary, input, select, textarea, [contenteditable], [tabindex], [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [role="menuitem"]';
        window.addEventListener("pointerdown", event => {
          if (!event.isTrusted || event.pointerType !== "touch") return;
          const elements = event.composedPath().filter(node => node instanceof Element);
          const interactive = elements.find(element => element.matches(control));
          const describe = element => {
            if (!element) return null;
            const label = element.getAttribute("aria-label") ?? "";
            const readText = (element === interactive || element.childElementCount === 0)
              && !element.closest(editable) && !element.querySelector(editable);
            const text = readText ? element.innerText?.trim() || label : label;
            return { tag: element.localName, role: element.getAttribute("role"), text: text.slice(0, tapLabelLimit) };
          };
          void window.recordUtTap(id, describe(elements[0]), describe(interactive)).catch(() => {});
        }, { capture: true, once: true, signal: AbortSignal.timeout(1000) });
      }, { id, tapLabelLimit });
      await page.touchscreen.tap(x, y);
      return await Promise.race([promise, delay(150, { target: null, interactive: null })]);
    } finally {
      pendingTap = undefined;
    }
  }

  return {
    page,
    takeAuth,
    close: () => context.close(),
    async snapshot() {
      const url = new URL(page.url());
      if (authInProgress || authUnsafe || authPath(url.pathname) || url.origin !== origin) {
        throw new Error("현재 화면은 관찰 범위 밖입니다.");
      }
      const image = await page.screenshot({ scale: "css", timeout: 5_000 });
      if (authInProgress || authAttempt || page.url() !== url.href) {
        throw new Error("화면이 바뀌어 캡처를 보류했습니다.");
      }
      const visibleText = await page.locator("body").evaluate(body => {
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        const text = [];
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const value = node.textContent.trim();
          if (!value || !node.parentElement) continue;
          const parent = node.parentElement;
          if (!parent.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })
            && getComputedStyle(parent).display !== "contents") continue;
          range.selectNodeContents(node);
          if ([...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0
            && rect.top < innerHeight && rect.bottom > 0 && rect.left < innerWidth && rect.right > 0)) {
            text.push(value);
          }
        }
        return text.join(" ");
      }, undefined, { timeout: 3_000 });
      if (authInProgress || authAttempt || page.url() !== url.href) {
        throw new Error("화면이 바뀌어 캡처를 보류했습니다.");
      }
      return { image, path: publicPath(url), visibleText: visibleText.slice(0, 1200) };
    },
    async act(action) {
      const { action: kind, x, y, text, deltaY, submit } = validateAction(action);
      if (authInProgress || authUnsafe || new URL(page.url()).origin !== origin) {
        throw new Error("현재 화면은 조작 범위 밖입니다.");
      }
      switch (kind) {
        case "tap":
          return tap(x, y);
        case "input": {
          const editable = await page.evaluate(() => {
            const el = document.activeElement;
            return el instanceof HTMLInputElement && ["text", "search", "tel", "number"].includes(el.type) && !el.readOnly && !el.disabled;
          });
          if (!editable) return "입력 가능한 항목에 초점이 없습니다.";
          if (text) await page.keyboard.insertText(text);
          if (submit) await page.keyboard.press("Enter");
          break;
        }
        case "scroll":
          await page.mouse.move(x, y);
          await page.mouse.wheel(0, deltaY);
          break;
        case "back":
          await page.goBack({ waitUntil: "domcontentloaded" });
          break;
      }
    },
  };
}
