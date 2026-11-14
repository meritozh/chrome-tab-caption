/**
 * Side Panel i18n — en + zh with live switch (no extension reload).
 * chrome.i18n cannot switch locale without reload, so the panel owns dictionaries.
 */

/** @typedef {'en' | 'zh'} UiLocale */

/** @type {Record<UiLocale, Record<string, string>>} */
export const MESSAGES = {
  en: {
    'product.title': 'Tab Caption',
    'product.tagline': 'Topics on demand. One window when you organize.',
    'nav.organize': 'Organize',
    'nav.settings': 'Settings',
    'nav.aria': 'Panel views',
    'locale.label': 'Language',
    'locale.en': 'English',
    'locale.zh': '中文',

    'organize.heading': 'Organize',
    'organize.lede':
      'One click classifies tabs, keeps the newest open, and merges into one window.',
    'organize.scope': 'Scope',
    'organize.scopeAll': 'All windows → single window',
    'organize.scopeCurrent': 'Current window only',
    'organize.btn': 'Organize tabs',
    'organize.reorganize': 'Reorganize',
    'organize.cancel': 'Cancel',
    'organize.ready':
      'Ready — Organize applies LLM topics immediately (Cancel stops an in-flight job).',
    'organize.reorganizeHint':
      'Reorganize clears the topic cache and re-classifies every open tab and Stack.',
    'organize.loadingSettings': 'Loading settings…',
    'organize.settingsRetry': 'Could not load settings. Click Organize to retry.',
    'organize.settingsLoaded': 'Settings loaded — click Organize again.',
    'organize.llmMissing':
      'LLM not configured — open Options and set provider + API key before Organize.',
    'organize.permissionDenied':
      'Host permission denied. Grant LLM + page access, then Organize again.',
    'organize.permissionRetry':
      'Host permission missing. Organize again after granting access.',
    'organize.busy': 'Organizing…',
    'organize.reorganizing': 'Reorganizing…',
    'organize.cancelling': 'Cancelling…',
    'organize.ended': 'Organize ended.',
    'organize.done':
      'Done — {topics} topics, {applied} groups{merged}{stacked}, {classified} classified.',
    'organize.merged': ' merged to one window',
    'organize.stacked': ', {n} stacked',
    'organize.failed': 'Organize failed',
    'organize.cancelNoLlm': 'Organize cancelled — no LLM calls.',
    'organize.cancelWithLlm':
      'Organize cancelled — {attempted} LLM {callWord} already sent{classifiedNote}. Already-sent requests cannot be recalled.',
    'organize.call': 'call',
    'organize.calls': 'calls',
    'organize.classifiedNote': ' ({n} classified before cancel)',

    'topics.heading': 'Topics',
    'topics.help': 'From the last Organize — physical groups live in the merged window.',
    'topics.empty': 'No topics yet — run Organize.',
    'topics.meta': ' · {tabs} tabs · windows {windows}',

    'search.heading': 'Search',
    'search.help': 'Fuzzy + pinyin over open tabs and Stacks. ↑↓ then Enter.',
    'search.placeholder': 'Title, URL, topic (pinyin OK)',
    'search.emptyPrompt': 'Type to search Open tabs and Stacked records.',
    'search.noMatches': 'No matches for “{query}”.',
    'search.error': 'Search error: {msg}',
    'search.open': 'Open',
    'search.stacked': 'Stacked',
    'search.noOpen': 'No open-tab matches.',
    'search.noStacked': 'No stacked matches.',
    'search.focused': 'Focused: {title}',
    'search.recalled': 'Recalled: {title}{group}',
    'search.groupRestored': ' (group restored)',
    'search.activateFailed': 'Activate failed',
    'search.recallFailed': 'Recall failed',
    'search.nothing': 'Nothing to activate.',
    'search.aria': 'Search open tabs and stacks',

    'stacks.heading': 'Stacks',
    'stacks.help':
      'Tabs this extension reclaimed (not browser recently-closed). Recall restores topic groups.',
    'stacks.empty': 'No stacked tabs yet — excess from Organize lands here.',
    'stacks.overflowTitle': 'Stack archive full',
    'stacks.export': 'Export oldest & free space',
    'stacks.discard': 'Discard oldest',
    'stacks.exporting': 'Exporting…',
    'stacks.discarding': 'Discarding oldest…',
    'stacks.exported': 'Exported and freed {n} oldest record(s).',
    'stacks.discarded': 'Discarded {n} oldest record(s).',
    'stacks.overflowFail': 'Overflow action failed',
    'stacks.recalled': 'Recalled: {title}{group}',
    'stacks.recallFailed': 'Recall failed',
    'stacks.noTopic': 'No topic',
    'stacks.recallTitle': 'Recall this stacked tab',
    'stacks.untitled': '(untitled)',
    'stacks.overflowExcess':
      'Archive over capacity by {excess} ({count}/{max}). Export or discard oldest to get back within the limit.',
    'stacks.overflowBlocked':
      'Archive at capacity ({count}/{max}). Choose export or discard to free space{blockedNote}. Reclaim is paused until then.',
    'stacks.blockedNote': ' for {n} more reclaim(s)',

    'settings.heading': 'Settings',
    'settings.help':
      'LLM endpoints, thresholds, and privacy live on the Options page. Organize stays in this panel — Options is settings only.',
    'settings.openOptions': 'Open Options',
    'preview.heading': 'Field preview',
    'preview.help':
      'Inspect classify fields for the active tab without starting Organize (informational only).',
    'preview.btn': 'Preview classify fields',

    'progress.clearedCache': 'Cleared topic cache…',
    'progress.quickPass': 'Quick pass: applying cached topics…',
    'progress.refine': 'Classifying {current}/{total}…',
    'progress.merge': 'Merging into one window…',
    'progress.stacks': 'Reclassifying stacks {current}/{total}…',
    'progress.done': 'Done.',
    'progress.cancelled': 'Cancelled.',
    'progress.error': 'Error.',
  },
  zh: {
    'product.title': 'Tab Caption',
    'product.tagline': '按需主题归类。整理时合并到一个窗口。',
    'nav.organize': '整理',
    'nav.settings': '设置',
    'nav.aria': '面板视图',
    'locale.label': '语言',
    'locale.en': 'English',
    'locale.zh': '中文',

    'organize.heading': '整理',
    'organize.lede': '一键分类标签页，保留最近使用的，并合并到一个窗口。',
    'organize.scope': '范围',
    'organize.scopeAll': '所有窗口 → 单个窗口',
    'organize.scopeCurrent': '仅当前窗口',
    'organize.btn': '整理标签页',
    'organize.reorganize': '重新整理',
    'organize.cancel': '取消',
    'organize.ready': '就绪 — 整理会立即应用 LLM 主题（取消可中止进行中的任务）。',
    'organize.reorganizeHint': '重新整理会清空主题缓存，并对所有打开标签页与堆栈重新分类。',
    'organize.loadingSettings': '正在加载设置…',
    'organize.settingsRetry': '无法加载设置。请再次点击整理重试。',
    'organize.settingsLoaded': '设置已加载 — 请再次点击整理。',
    'organize.llmMissing': '未配置 LLM — 请先在选项中设置提供商和 API 密钥。',
    'organize.permissionDenied': '未授予主机权限。请允许 LLM 与页面访问后再次整理。',
    'organize.permissionRetry': '缺少主机权限。授予访问后请再次整理。',
    'organize.busy': '正在整理…',
    'organize.reorganizing': '正在重新整理…',
    'organize.cancelling': '正在取消…',
    'organize.ended': '整理已结束。',
    'organize.done':
      '完成 — {topics} 个主题，{applied} 个分组{merged}{stacked}，已分类 {classified}。',
    'organize.merged': '，已合并到一个窗口',
    'organize.stacked': '，堆栈 {n} 个',
    'organize.failed': '整理失败',
    'organize.cancelNoLlm': '已取消整理 — 未发起 LLM 调用。',
    'organize.cancelWithLlm':
      '已取消整理 — 已发送 {attempted} 次 LLM {callWord}{classifiedNote}。已发出的请求无法撤回。',
    'organize.call': '调用',
    'organize.calls': '调用',
    'organize.classifiedNote': '（取消前已分类 {n}）',

    'topics.heading': '主题',
    'topics.help': '来自上次整理 — 物理分组位于合并后的窗口中。',
    'topics.empty': '尚无主题 — 请运行整理。',
    'topics.meta': ' · {tabs} 个标签页 · 窗口 {windows}',

    'search.heading': '搜索',
    'search.help': '对打开标签页与堆栈进行模糊 / 拼音搜索。↑↓ 后按 Enter。',
    'search.placeholder': '标题、URL、主题（支持拼音）',
    'search.emptyPrompt': '输入以搜索打开的标签页与堆栈记录。',
    'search.noMatches': '没有与“{query}”匹配的结果。',
    'search.error': '搜索错误：{msg}',
    'search.open': '打开中',
    'search.stacked': '堆栈',
    'search.noOpen': '无打开标签页匹配。',
    'search.noStacked': '无堆栈匹配。',
    'search.focused': '已聚焦：{title}',
    'search.recalled': '已召回：{title}{group}',
    'search.groupRestored': '（已恢复分组）',
    'search.activateFailed': '激活失败',
    'search.recallFailed': '召回失败',
    'search.nothing': '无可激活项。',
    'search.aria': '搜索打开的标签页与堆栈',

    'stacks.heading': '堆栈',
    'stacks.help': '由本扩展回收的标签页（非浏览器最近关闭）。召回可恢复主题分组。',
    'stacks.empty': '尚无堆栈标签页 — 整理多余的标签页会进入此处。',
    'stacks.overflowTitle': '堆栈归档已满',
    'stacks.export': '导出最旧并腾出空间',
    'stacks.discard': '丢弃最旧',
    'stacks.exporting': '正在导出…',
    'stacks.discarding': '正在丢弃最旧…',
    'stacks.exported': '已导出并释放 {n} 条最旧记录。',
    'stacks.discarded': '已丢弃 {n} 条最旧记录。',
    'stacks.overflowFail': '溢出操作失败',
    'stacks.recalled': '已召回：{title}{group}',
    'stacks.recallFailed': '召回失败',
    'stacks.noTopic': '无主题',
    'stacks.recallTitle': '召回此堆栈标签页',
    'stacks.untitled': '（无标题）',
    'stacks.overflowExcess':
      '归档超出容量 {excess}（{count}/{max}）。请导出或丢弃最旧记录以回到限制内。',
    'stacks.overflowBlocked':
      '归档已满（{count}/{max}）。请选择导出或丢弃以腾出空间{blockedNote}。回收已暂停。',
    'stacks.blockedNote': '（还需 {n} 次回收）',

    'settings.heading': '设置',
    'settings.help':
      'LLM 端点、阈值与隐私设置在选项页。整理仅在此面板 — 选项页只负责设置。',
    'settings.openOptions': '打开选项',
    'preview.heading': '字段预览',
    'preview.help': '查看当前标签页的分类字段（仅供参考，不会开始整理）。',
    'preview.btn': '预览分类字段',

    'progress.clearedCache': '已清空主题缓存…',
    'progress.quickPass': '快速通道：应用缓存主题…',
    'progress.refine': '正在分类 {current}/{total}…',
    'progress.merge': '正在合并到一个窗口…',
    'progress.stacks': '正在重新分类堆栈 {current}/{total}…',
    'progress.done': '完成。',
    'progress.cancelled': '已取消。',
    'progress.error': '出错。',
  },
};

/**
 * @param {unknown} value
 * @returns {UiLocale}
 */
export function normalizeUiLocale(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'zh' || raw === 'zh-cn' || raw === 'zh_hans' || raw.startsWith('zh')) {
    return 'zh';
  }
  return 'en';
}

/**
 * Nested i18n fragment resolved at render time (locale-switch safe).
 * @typedef {{ key: string, params?: Record<string, string | number | I18nParamRef> | null }} I18nParamRef
 */

/**
 * @param {UiLocale} locale
 * @param {unknown} value
 * @returns {string}
 */
function resolveParamValue(locale, value) {
  if (
    value &&
    typeof value === 'object' &&
    typeof /** @type {I18nParamRef} */ (value).key === 'string'
  ) {
    const ref = /** @type {I18nParamRef} */ (value);
    return t(locale, ref.key, ref.params ?? null);
  }
  return String(value ?? '');
}

/**
 * @param {UiLocale | string} locale
 * @param {string} key
 * @param {Record<string, string | number | I18nParamRef> | null} [params]
 */
export function t(locale, key, params = null) {
  const loc = normalizeUiLocale(locale);
  const table = MESSAGES[loc] || MESSAGES.en;
  let text = table[key] ?? MESSAGES.en[key] ?? key;
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, resolveParamValue(loc, v));
    }
  }
  return text;
}

/**
 * Apply translations to elements with data-i18n / data-i18n-placeholder / data-i18n-aria / data-i18n-title.
 * @param {ParentNode} [root]
 * @param {UiLocale | string} locale
 */
export function applyDomI18n(root = document, locale = 'en') {
  const loc = normalizeUiLocale(locale);
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (!key) return;
    el.textContent = t(loc, key);
  });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const key = el.getAttribute('data-i18n-html');
    if (!key) return;
    el.innerHTML = t(loc, key);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (!key) return;
    el.setAttribute('placeholder', t(loc, key));
  });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria');
    if (!key) return;
    el.setAttribute('aria-label', t(loc, key));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    if (!key) return;
    el.setAttribute('title', t(loc, key));
  });
  if (root.documentElement) {
    root.documentElement.lang = loc === 'zh' ? 'zh-CN' : 'en';
  } else if (typeof document !== 'undefined') {
    document.documentElement.lang = loc === 'zh' ? 'zh-CN' : 'en';
  }
}
