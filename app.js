/* =============================================================================
   Recipe Mom — app.js
   Vanilla ES2020. No framework, no build. Renders the entire site from
   site.json + recipes.json into the shell in index.html, styled by styles.css.

   Contract notes honoured here:
   - Every recipe field is optional; a {id,title} recipe renders cleanly.
   - All interpolated data passes through esc(); nothing prints undefined/NaN.
   - Hash routing: #/  #/recipes  #/recipe/<id>  #/category/<c>
     #/search?q=<t>  #/collection/<id>.  Unknown/empty -> home.
   - localStorage keys: rm-theme, rm-units, rm-progress-<id>.
   - One IntersectionObserver, rebuilt per render (revealAll).
   - Scroll work is rAF-throttled.
   ========================================================================== */
(function () {
  'use strict';

  document.documentElement.classList.remove('no-js');
  document.documentElement.classList.add('js');

  /* ---------------------------------------------------------------- els */
  var $  = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var el = {
    app:        $('#app'),
    hero:       $('#hero'),
    heroEyebrow:$('#hero-eyebrow'),
    heroTitle:  $('#hero-title'),
    heroSub:    $('#hero-sub'),
    heroCta:    $('#hero-cta'),
    heroCard:   $('#hero-card'),
    brandName:  $('#brand-name'),
    navRoot:    $('#nav-root'),
    mobileNav:  $('#mobile-nav'),
    navToggle:  $('#nav-toggle'),
    themeToggle:$('#theme-toggle'),
    searchForm: $('#search-form'),
    searchInput:$('#search-input'),
    searchSuggest: $('#search-suggest'),
    searchToggle: $('#search-toggle'),
    footer:     $('#site-footer'),
    skeleton:   $('#skeleton'),
    progress:   $('#scroll-progress'),
    backToTop:  $('#back-to-top'),
    toastRoot:  $('#toast-root')
  };

  /* --------------------------------------------------------------- state */
  var state = {
    site: null,
    recipes: [],
    byId: {},
    units: 'us',            // 'us' | 'metric'
    heroTimer: 0,
    heroIndex: 0,
    io: null,               // IntersectionObserver
    suggestItems: [],       // current suggestion list
    suggestActive: -1,
    session: { signedIn: false, email: '' }
  };

  /* ============================================================ utilities */

  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  // Escape for use inside an attribute like href where we also want URL-ish safety.
  function escAttr(v) { return esc(v); }

  function isStr(v) { return typeof v === 'string' && v.trim() !== ''; }
  function num(v) { var n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : 0; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function debounce(fn, ms) {
    var t; return function () {
      var ctx = this, a = arguments;
      clearTimeout(t); t = setTimeout(function () { fn.apply(ctx, a); }, ms);
    };
  }
  function rafThrottle(fn) {
    var queued = false, lastArgs;
    return function () {
      lastArgs = arguments;
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; fn.apply(null, lastArgs); });
    };
  }

  // Parse a human duration like "1 hr 30 min", "45 min", "2 hr", "1h20", "90m".
  function parseMinutes(s) {
    if (typeof s === 'number') return s > 0 ? s : 0;
    if (!isStr(s)) return 0;
    var str = s.toLowerCase();
    var total = 0, matched = false;
    var re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|days?|d)/g, m;
    while ((m = re.exec(str))) {
      matched = true;
      var val = parseFloat(m[1]), unit = m[2];
      if (unit[0] === 'h') total += val * 60;
      else if (unit[0] === 'd') total += val * 60 * 24;
      else total += val;
    }
    if (!matched) { var only = parseFloat(str); if (isFinite(only)) total = only; }
    return Math.round(total);
  }

  // Human quantity formatting.
  var VULGAR = { '0.125': '⅛', '0.25': '¼', '0.333': '⅓', '0.375': '⅜',
                 '0.5': '½', '0.625': '⅝', '0.667': '⅔', '0.75': '¾', '0.875': '⅞' };
  function nearestEighth(x) { return Math.round(x * 8) / 8; }

  function formatUS(q) {
    if (!(q > 0)) return '';
    if (q >= 10) return String(Math.round(q * 4) / 4).replace(/\.0+$/, '');
    var snapped = nearestEighth(q);
    var whole = Math.floor(snapped + 1e-9);
    var frac = snapped - whole;
    var key = frac.toFixed(3);
    // Normalise the two thirds-keys we rounded to 3dp.
    if (key === '0.333') key = '0.333';
    var glyph = VULGAR[key];
    if (frac < 1e-6) return String(whole);
    if (glyph) return (whole > 0 ? whole + ' ' : '') + glyph;
    // Fallback: one decimal.
    return String(Math.round(snapped * 10) / 10);
  }

  function formatMetric(q) {
    if (!(q > 0)) return '';
    if (q >= 100) return String(Math.round(q / 5) * 5);
    if (q >= 20)  return String(Math.round(q));
    if (q >= 1)   return String(Math.round(q * 10) / 10);
    return String(Math.round(q * 100) / 100);
  }

  function scaleQty(baseQty, factor, units) {
    var q = num(baseQty) * factor;
    return units === 'metric' ? formatMetric(q) : formatUS(q);
  }

  // Star rating markup using the :empty + --fill CSS variant.
  function starsHtml(rating, size) {
    var r = clamp(num(rating), 0, 5);
    var pct = Math.round((r / 5) * 100);
    var cls = 'stars' + (size === 'lg' ? ' stars--lg' : size === 'sm' ? ' stars--sm' : '');
    return '<span class="' + cls + '" style="--fill:' + pct + '%" role="img" aria-label="Rated '
      + (Math.round(r * 10) / 10) + ' out of 5"></span>';
  }

  function ratingText(r) { var n = num(r); return n > 0 ? (Math.round(n * 10) / 10).toFixed(1) : ''; }

  // Pick the shortest meaningful "time" for a card.
  function cardTime(r) {
    return isStr(r.total) ? r.total : isStr(r.active) ? r.active : isStr(r.cook) ? r.cook : isStr(r.prep) ? r.prep : '';
  }

  function illRef(r) {
    var id = isStr(r.ill) ? r.ill : 'ill-bowl';
    return id;
  }

  /* ============================================================= card html */

  // Picture for a card. A recipe added as an image-only recipe may have no
  // separate photo, so fall back to its poster and anchor the crop to the top
  // (a recipe infographic keeps its title up there).
  function cardImage(r) {
    if (isStr(r.img)) return { src: r.img, cls: 'card__img' };
    if (isStr(r.poster)) return { src: r.poster, cls: 'card__img card__img--poster' };
    return null;
  }

  function cardHtml(r, stagger) {
    if (!r || !isStr(r.id)) return '';
    var href = '#/recipe/' + encodeURIComponent(r.id);
    var media;
    var pic = cardImage(r);
    if (pic) {
      media = '<img class="' + pic.cls + '" src="' + escAttr(pic.src) + '" alt="' + escAttr(r.title || '') + '" loading="lazy" decoding="async">';
    } else {
      media = '<svg class="card__ill" viewBox="0 0 200 150" role="img" aria-label="' + escAttr(r.title || 'Recipe') + '">'
            + '<use href="#' + escAttr(illRef(r)) + '"></use></svg>';
    }
    var badge = isStr(r.badge) ? '<span class="card__badge">' + esc(r.badge) + '</span>' : '';
    var rt = ratingText(r.rating);
    var reviews = num(r.reviews);
    var ratingBlock = rt
      ? '<span class="card__rating">' + starsHtml(r.rating, 'sm') + ' ' + esc(rt)
        + (reviews > 0 ? ' <span class="stars__count">(' + esc(reviews) + ')</span>' : '') + '</span>'
      : '';
    var t = cardTime(r);
    var timeBlock = isStr(t) ? '<span class="card__time">' + esc(t) + '</span>' : '';
    var cat = isStr(r.cat) ? '<span class="card__cat">' + esc(r.cat) + '</span>' : '';
    var desc = isStr(r.desc) ? '<p class="card__desc">' + esc(r.desc) + '</p>' : '';
    var st = (stagger || stagger === 0) ? ' data-stagger="' + (clamp(stagger, 0, 12)) + '"' : '';

    return '<a class="card reveal"' + st + ' href="' + href + '">'
      +   '<span class="card__media">' + media + badge + '</span>'
      +   '<span class="card__body">'
      +     cat
      +     '<h3 class="card__title">' + esc(r.title || 'Untitled') + '</h3>'
      +     desc
      +     '<span class="card__meta">' + ratingBlock + timeBlock + '</span>'
      +   '</span>'
      + '</a>';
  }

  function gridHtml(list, opts) {
    opts = opts || {};
    if (!list.length) {
      return emptyHtml(opts.emptyTitle || 'Nothing here yet',
                       opts.emptyMsg || 'No recipes match. Try a different filter or search.');
    }
    var cls = 'grid' + (opts.large ? ' grid--lg' : '') + (opts.filtering ? ' is-filtering' : '');
    var cards = list.map(function (r, i) { return cardHtml(r, (i % 12) + 1); }).join('');
    return '<div class="' + cls + '">' + cards + '</div>';
  }

  function emptyHtml(title, msg, ctaHref, ctaLabel) {
    return '<div class="empty">'
      + '<strong>' + esc(title) + '</strong>'
      + '<p>' + esc(msg) + '</p>'
      + (ctaHref ? '<a class="btn btn--primary" href="' + escAttr(ctaHref) + '">' + esc(ctaLabel || 'Browse recipes') + '</a>' : '')
      + '</div>';
  }

  /* ============================================================ data logic */

  function allCategories() {
    var fromSite = arr(state.site && state.site.categories).filter(isStr);
    if (fromSite.length) return fromSite;
    var seen = {}, out = [];
    state.recipes.forEach(function (r) { if (isStr(r.cat) && !seen[r.cat]) { seen[r.cat] = 1; out.push(r.cat); } });
    return out;
  }

  function recipesInCategory(cat) {
    return state.recipes.filter(function (r) { return r.cat === cat; });
  }

  function featuredRecipes() {
    var f = state.recipes.filter(function (r) { return r.featured; });
    return f.length ? f : state.recipes.slice(0, 5);
  }

  // Apply a collection filter object: {maxMinutes, minRating, cat, tag}.
  function applyFilter(list, f) {
    if (!f) return list.slice();
    return list.filter(function (r) {
      if (typeof f.maxMinutes === 'number') { var mins = parseMinutes(r.total || r.active || r.cook); if (!(mins > 0 && mins <= f.maxMinutes)) return false; }
      if (typeof f.minRating === 'number') { if (num(r.rating) < f.minRating) return false; }
      if (isStr(f.cat)) { if (r.cat !== f.cat) return false; }
      if (isStr(f.tag)) { if (arr(r.tags).map(String).map(function (t) { return t.toLowerCase(); }).indexOf(f.tag.toLowerCase()) === -1) return false; }
      return true;
    });
  }

  function collectionById(id) {
    return arr(state.site && state.site.collections).filter(Boolean).filter(function (c) { return c && c.id === id; })[0];
  }

  // Search index & matcher.
  function recipeMatches(r, q) {
    if (!isStr(q)) return true;
    var hay = [
      r.title, r.desc, r.lede, r.cat, r.author,
      arr(r.tags).join(' '),
      arr(r.ingredientGroups).map(function (g) { return arr(g && g.items).map(function (it) { return it && it.name; }).join(' '); }).join(' ')
    ].filter(isStr).join(' • ').toLowerCase();
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return terms.every(function (t) { return hay.indexOf(t) !== -1; });
  }

  function searchRecipes(q) {
    if (!isStr(q)) return state.recipes.slice();
    var ql = q.toLowerCase();
    var scored = state.recipes.filter(function (r) { return recipeMatches(r, q); }).map(function (r) {
      var score = 0;
      if (isStr(r.title) && r.title.toLowerCase().indexOf(ql) !== -1) score += 10;
      if (isStr(r.cat) && r.cat.toLowerCase().indexOf(ql) !== -1) score += 4;
      if (arr(r.tags).join(' ').toLowerCase().indexOf(ql) !== -1) score += 3;
      score += num(r.rating);
      return { r: r, score: score };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.map(function (s) { return s.r; });
  }

  function relatedRecipes(r, max) {
    max = max || 4;
    var others = state.recipes.filter(function (x) { return x.id !== r.id; });
    var tagSet = {}; arr(r.tags).forEach(function (t) { if (isStr(t)) tagSet[t.toLowerCase()] = 1; });
    var scored = others.map(function (x) {
      var score = 0;
      if (x.cat === r.cat) score += 5;
      arr(x.tags).forEach(function (t) { if (isStr(t) && tagSet[t.toLowerCase()]) score += 2; });
      score += num(x.rating) * 0.1;
      return { x: x, score: score };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.filter(function (s) { return s.score > 0; }).slice(0, max).map(function (s) { return s.x; });
  }

  /* ============================================================== sorting */

  var SORTS = {
    newest:  function (a, b) { return state.recipes.indexOf(b) - state.recipes.indexOf(a); },
    top:     function (a, b) { return num(b.rating) - num(a.rating) || num(b.reviews) - num(a.reviews); },
    quick:   function (a, b) { return (parseMinutes(a.total) || 1e9) - (parseMinutes(b.total) || 1e9); },
    az:      function (a, b) { return String(a.title || '').localeCompare(String(b.title || '')); }
  };

  /* =============================================================== header */

  function buildHeader() {
    var site = state.site || {};
    if (el.brandName) el.brandName.textContent = site.brand || 'Recipe Mom';

    // Desktop nav + mega menus.
    var nav = arr(site.nav);
    var lis = nav.map(function (item, idx) {
      var label = esc(item && item.label || 'Menu');
      var cols = arr(item && item.columns);
      if (!cols.length) {
        // Simple link item.
        var href = isStr(item && item.href) ? item.href : '#/recipes';
        return '<li class="nav__item"><a class="nav__link" href="' + escAttr(href) + '">' + label + '</a></li>';
      }
      var panelId = 'mega-' + idx;
      var colsHtml = cols.map(function (c) {
        var links = arr(c && c.links).map(function (lk) {
          return '<li><a href="' + escAttr(navLinkHref(lk)) + '">' + esc(lk && lk.label || '') + '</a></li>';
        }).join('');
        return '<div class="mega__col"><h3 class="mega__heading">' + esc(c && c.heading || '') + '</h3><ul>' + links + '</ul></div>';
      }).join('');
      return '<li class="nav__item">'
        + '<button class="nav__link" type="button" aria-expanded="false" aria-controls="' + panelId + '">' + label + '</button>'
        + '<div class="mega" id="' + panelId + '"><div class="mega__cols">' + colsHtml + '</div></div>'
        + '</li>';
    }).join('');
    el.navRoot.innerHTML = '<ul class="nav__list">' + lis + '</ul>';
    wireMegaMenus();

    // Mobile drawer.
    buildMobileNav();
  }

  function navLinkHref(lk) {
    if (!lk) return '#/recipes';
    if (isStr(lk.href)) return lk.href;
    if (isStr(lk.cat)) return '#/category/' + encodeURIComponent(lk.cat);
    if (isStr(lk.collection)) return '#/collection/' + encodeURIComponent(lk.collection);
    if (isStr(lk.label)) return '#/search?q=' + encodeURIComponent(lk.label);
    return '#/recipes';
  }

  function wireMegaMenus() {
    var items = $$('#nav-root .nav__item');
    items.forEach(function (li) {
      var btn = $('button.nav__link', li);
      var panel = $('.mega', li);
      if (!btn || !panel) return;
      var openFn = function () { closeAllMega(li); li.classList.add('is-open'); panel.classList.add('is-open'); btn.setAttribute('aria-expanded', 'true'); };
      var closeFn = function () { li.classList.remove('is-open'); panel.classList.remove('is-open'); btn.setAttribute('aria-expanded', 'false'); };
      var hoverTimer;
      li.addEventListener('mouseenter', function () { clearTimeout(hoverTimer); if (window.matchMedia('(hover:hover)').matches) openFn(); });
      li.addEventListener('mouseleave', function () { if (window.matchMedia('(hover:hover)').matches) { hoverTimer = setTimeout(closeFn, 90); } });
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        if (li.classList.contains('is-open')) closeFn(); else openFn();
      });
      // Keyboard: close on Esc, move focus back to button.
      panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeFn(); btn.focus(); } });
      // Close when focus leaves the item entirely.
      li.addEventListener('focusout', function (e) { if (!li.contains(e.relatedTarget)) closeFn(); });
      // Clicking a link inside closes it.
      $$('a', panel).forEach(function (a) { a.addEventListener('click', closeFn); });
    });
  }

  function closeAllMega(except) {
    $$('#nav-root .nav__item.is-open').forEach(function (li) {
      if (li === except) return;
      li.classList.remove('is-open');
      var p = $('.mega', li); if (p) p.classList.remove('is-open');
      var b = $('button.nav__link', li); if (b) b.setAttribute('aria-expanded', 'false');
    });
  }

  // The phone menu is built from what the site actually contains, not from the
  // desktop mega-menu. Mirroring that menu produced ~37 rows in which every
  // category appeared two or three times under different names.
  function buildMobileNav() {
    var site = state.site || {};
    var html = '';

    html += '<button type="button" class="mnav__search" id="mnav-search">'
         +  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">'
         +  '<circle cx="11" cy="11" r="6.5"></circle><path d="M16 16l4.5 4.5"></path></svg>'
         +  '<span>Search recipes</span></button>';
    html += '<a class="mnav__all" href="#/recipes">All recipes'
         +  '<span class="mnav__count">' + state.recipes.length + '</span></a>';

    var cats = allCategories().map(function (c) {
      return { name: c, n: recipesInCategory(c).length };
    }).filter(function (c) { return c.n > 0; });

    if (cats.length) {
      html += '<h3>Browse by category</h3><ul>';
      cats.forEach(function (c) {
        html += '<li><a href="#/category/' + encodeURIComponent(c.name) + '">' + esc(c.name)
             +  '<span class="mnav__count">' + c.n + '</span></a></li>';
      });
      html += '</ul>';
    }

    // A short editorial shelf — these are real filters, unlike the old menu.
    var colls = arr(site.collections).filter(Boolean).map(function (c) {
      return { c: c, n: applyFilter(state.recipes, c.filter).length };
    }).filter(function (x) { return x.n > 0; }).slice(0, 4);

    if (state.session && state.session.signedIn) {
      html += '<h3>Manage</h3><ul>'
           +  '<li><a href="#/admin">My recipes</a></li></ul>';
    }

    if (colls.length) {
      html += '<h3>Collections</h3><ul>';
      colls.forEach(function (x) {
        html += '<li><a href="#/collection/' + encodeURIComponent(x.c.id) + '">' + esc(x.c.label || x.c.id)
             +  '<span class="mnav__count">' + x.n + '</span></a></li>';
      });
      html += '</ul>';
    }

    el.mobileNav.innerHTML = html;
    $$('a', el.mobileNav).forEach(function (a) { a.addEventListener('click', closeMobileNav); });
    var sb = $('#mnav-search', el.mobileNav);
    if (sb) sb.addEventListener('click', function () { closeMobileNav(); openHeaderSearch(); });
  }

  function openMobileNav() {
    closeHeaderSearch();
    el.mobileNav.classList.add('is-open');
    el.navToggle.setAttribute('aria-expanded', 'true');
    el.navToggle.setAttribute('aria-label', 'Close menu');
    document.body.classList.add('nav-open');
    var first = $('a, button', el.mobileNav); if (first) first.focus();
  }
  function closeMobileNav() {
    el.mobileNav.classList.remove('is-open');
    el.navToggle.setAttribute('aria-expanded', 'false');
    el.navToggle.setAttribute('aria-label', 'Open menu');
    document.body.classList.remove('nav-open');
  }
  function toggleMobileNav() {
    if (el.mobileNav.classList.contains('is-open')) closeMobileNav(); else openMobileNav();
  }

  /* =============================================================== footer */

  function buildFooter() {
    var site = state.site || {};
    var f = site.footer || {};
    var cols = arr(f.columns);
    var colsHtml = cols.map(function (c) {
      var links = arr(c && c.links).map(function (lk) {
        return '<li><a href="' + escAttr(navLinkHref(lk)) + '">' + esc(lk && lk.label || '') + '</a></li>';
      }).join('');
      return '<div class="footer__col"><h3>' + esc(c && c.heading || '') + '</h3><ul>' + links + '</ul></div>';
    }).join('');
    var year = 2026;
    var note = isStr(f.note) ? f.note : (site.tagline || '');
    el.footer.innerHTML =
        '<div class="section footer__inner">'
      +   '<div class="footer__brand">'
      +     '<a class="brand__name" href="#/">' + esc(site.brand || 'Recipe Mom') + '</a>'
      +     '<p class="footer__note">' + esc(note) + '</p>'
      +   '</div>'
      +   '<div class="footer__cols">' + colsHtml + '</div>'
      +   '<p class="footer__legal muted">© ' + year + ' ' + esc(site.brand || 'Recipe Mom') + '. Recipes for the love of it.</p>'
      + '</div>';
  }

  /* ================================================================ hero */

  function fillHeroCopy() {
    var h = (state.site && state.site.hero) || {};
    if (el.heroEyebrow) el.heroEyebrow.textContent = h.eyebrow || 'Today’s pick';
    if (el.heroTitle)   el.heroTitle.textContent = h.title || 'Cook something you’ll want again tomorrow';
    if (el.heroSub)     el.heroSub.textContent = h.sub || '';
    if (el.heroCta) {
      el.heroCta.textContent = h.cta || 'Browse all recipes';
      el.heroCta.setAttribute('href', '#/recipes');
    }
  }

  function heroCardHtml(r, dotsCount, activeDot) {
    if (!r) return '';
    var href = '#/recipe/' + encodeURIComponent(r.id);
    var hpic = cardImage(r);
    var media = hpic
      ? '<img class="' + hpic.cls + '" src="' + escAttr(hpic.src) + '" alt="' + escAttr(r.title || '') + '">'
      : '<svg class="card__ill" viewBox="0 0 200 150" role="img" aria-label="' + escAttr(r.title || 'Recipe') + '"><use href="#' + escAttr(illRef(r)) + '"></use></svg>';
    var dots = '';
    if (dotsCount > 1) {
      var b = '';
      for (var i = 0; i < dotsCount; i++) {
        b += '<button type="button" class="hero__dot' + (i === activeDot ? ' is-on' : '') + '" data-dot="' + i + '"'
          + ' aria-current="' + (i === activeDot ? 'true' : 'false') + '" aria-label="Show featured recipe ' + (i + 1) + '"></button>';
      }
      dots = '<div class="hero__dots">' + b + '</div>';
    }
    var rt = ratingText(r.rating);
    var meta = (rt ? '<span class="card__rating">' + starsHtml(r.rating, 'sm') + ' ' + esc(rt) + '</span>' : '')
             + (isStr(cardTime(r)) ? '<span class="card__time">' + esc(cardTime(r)) + '</span>' : '');
    // An image-only recipe already carries its title inside the picture, so the
    // hero must not overlay a second title on top of a busy infographic.
    return '<a class="card' + (isStr(r.poster) ? ' card--poster' : '') + '" href="' + href + '">'
      +  '<span class="card__media">' + media + dots + '</span>'
      +  '<span class="card__body">'
      +    (isStr(r.cat) ? '<span class="card__cat">' + esc(r.cat) + '</span>' : '')
      +    '<h3 class="card__title">' + esc(r.title || '') + '</h3>'
      +    (isStr(r.desc) ? '<p class="card__desc">' + esc(r.desc) + '</p>' : '')
      +    '<span class="card__meta">' + meta + '</span>'
      +  '</span>'
      + '</a>';
  }

  function renderHeroCard() {
    var feats = featuredRecipes();
    if (!feats.length) { el.heroCard.innerHTML = ''; return; }
    // Prefer site.hero.featured as the first slide.
    var wantId = state.site && state.site.hero && state.site.hero.featured;
    if (isStr(wantId)) {
      var idx = feats.map(function (r) { return r.id; }).indexOf(wantId);
      if (idx > 0) { var pick = feats.splice(idx, 1)[0]; feats.unshift(pick); }
    }
    state._heroList = feats;
    state.heroIndex = clamp(state.heroIndex, 0, feats.length - 1);
    paintHeroSlide();
    // Wire dot clicks (delegated once per render).
    el.heroCard.onclick = function (e) {
      var dot = e.target.closest && e.target.closest('.hero__dot');
      if (dot) {
        e.preventDefault();
        state.heroIndex = parseInt(dot.getAttribute('data-dot'), 10) || 0;
        paintHeroSlide(); restartHeroTimer();
      }
    };
  }

  function paintHeroSlide() {
    var feats = state._heroList || [];
    if (!feats.length) return;
    var r = feats[state.heroIndex % feats.length];
    el.heroCard.innerHTML = heroCardHtml(r, feats.length, state.heroIndex % feats.length);
    // Retrigger the swap animation.
    var card = $('.card', el.heroCard);
    if (card) { card.style.animation = 'heroSwap 620ms var(--ease) both'; }
  }

  function startHeroRotation() {
    stopHeroRotation();
    var feats = state._heroList || [];
    if (feats.length < 2) return;
    state.heroTimer = setInterval(function () {
      state.heroIndex = (state.heroIndex + 1) % feats.length;
      paintHeroSlide();
    }, 7000);
  }
  function stopHeroRotation() { if (state.heroTimer) { clearInterval(state.heroTimer); state.heroTimer = 0; } }
  function restartHeroTimer() { startHeroRotation(); }

  function showHero(show) {
    if (!el.hero) return;
    el.hero.hidden = !show;
    if (show) { renderHeroCard(); startHeroRotation(); } else { stopHeroRotation(); }
  }

  // Pause rotation when the hero is hovered or focused.
  if (el.hero) {
    el.hero.addEventListener('mouseenter', stopHeroRotation);
    el.hero.addEventListener('mouseleave', function () { if (!el.hero.hidden) startHeroRotation(); });
    el.hero.addEventListener('focusin', stopHeroRotation);
    el.hero.addEventListener('focusout', function () { if (!el.hero.hidden) startHeroRotation(); });
  }

  /* =============================================================== routes */

  function parseHash() {
    var h = location.hash || '';
    if (h.charAt(0) === '#') h = h.slice(1);
    if (h.charAt(0) === '/') h = h.slice(1);
    var qIdx = h.indexOf('?');
    var query = {};
    if (qIdx !== -1) {
      var qs = h.slice(qIdx + 1); h = h.slice(0, qIdx);
      qs.split('&').forEach(function (pair) {
        if (!pair) return;
        var kv = pair.split('=');
        query[decodeURIComponent(kv[0] || '')] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
      });
    }
    var parts = h.split('/').filter(function (p) { return p !== ''; }).map(function (p) { return decodeURIComponent(p); });
    return { parts: parts, query: query };
  }

  function setMeta(title, desc) {
    document.title = title ? (title + ' · ' + (state.site && state.site.brand || 'Recipe Mom')) : (state.site && state.site.brand || 'Recipe Mom');
    var m = $('meta[name="description"]');
    if (m && isStr(desc)) m.setAttribute('content', desc);
  }

  function removeRecipeJsonLd() {
    var old = $('#recipe-jsonld'); if (old) old.parentNode.removeChild(old);
  }

  function render() {
    var route = parseHash();
    var parts = route.parts;
    closeAllMega(); closeMobileNav(); hideSuggest(); closeLightbox(); closeHeaderSearch();
    removeRecipeJsonLd();

    var head = parts[0] || '';
    var html, isHome = false;

    if (head === '' || head === 'home') { html = renderHome(); isHome = true; }
    else if (head === 'recipes') html = renderAll(route.query);
    else if (head === 'recipe') html = renderRecipe(parts[1]);
    else if (head === 'category') html = renderCategory(parts[1]);
    else if (head === 'collection') html = renderCollection(parts[1]);
    else if (head === 'search') html = renderSearch(route.query.q || '');
    else if (head === 'login') html = renderLogin();
    else if (head === 'admin') html = renderAdmin();
    else { html = renderHome(); isHome = true; }

    el.app.innerHTML = html;
    el.app.setAttribute('aria-busy', 'false');

    showHero(isHome);

    // Route-enter animation.
    el.app.classList.remove('page-enter');
    void el.app.offsetWidth; // reflow so the animation restarts
    el.app.classList.add('page-enter');

    window.scrollTo(0, 0);

    // Wire whatever the freshly-rendered route needs.
    wireRouteInteractions(head, parts, route.query);
    revealAll();
    syncSearchInput(head, route.query);
  }

  /* ---------------------------------------------------------------- home */

  function renderHome() {
    var site = state.site || {};
    var cats = allCategories();
    var all = state.recipes.slice();

    // Category chip row.
    // Only offer a category that actually has something in it — an empty one
    // is a dead end. It stays in site.json so the CMS can still assign it.
    var liveCats = cats.filter(function (c) { return recipesInCategory(c).length > 0; });
    var chipRow = '<div class="chiprow chiprow--scroll" role="list" aria-label="Categories">'
      + '<a class="chip" href="#/recipes" role="listitem">All</a>'
      + liveCats.map(function (c) { return '<a class="chip" href="#/category/' + encodeURIComponent(c) + '" role="listitem">' + esc(c) + '</a>'; }).join('')
      + '</div>';

    // The big "plenty to choose from" grid — at least 24 cards.
    var big = all.slice(0, Math.max(24, Math.min(all.length, 24)));
    if (all.length > 24) big = all.slice(0, 24);
    var bigGrid = '<section class="section reveal">'
      + '<div class="section__head"><h2 class="section__title">Plenty to choose from</h2>'
      + '<a class="section__link" href="#/recipes">See all ' + all.length + '</a></div>'
      + gridHtml(big, { large: false })
      + '</section>';

    // One rail per collection.
    var rails = arr(site.collections).filter(Boolean).map(function (c) {
      var list = applyFilter(all, c.filter).slice(0, 12);
      if (!list.length) return '';
      var track = list.map(function (r, i) { return cardHtml(r, (i % 12) + 1); }).join('');
      return '<section class="section reveal">'
        + '<div class="section__head"><h2 class="section__title">' + esc(c.label || 'Collection') + '</h2>'
        + '<a class="section__link" href="#/collection/' + encodeURIComponent(c.id) + '">See all</a></div>'
        + (isStr(c.desc) ? '<p class="section__desc">' + esc(c.desc) + '</p>' : '')
        + '<div class="rail"><div class="rail__track">' + track + '</div>'
        + '<button class="rail__btn rail__btn--prev" type="button" aria-label="Scroll left" data-dir="prev"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>'
        + '<button class="rail__btn rail__btn--next" type="button" aria-label="Scroll right" data-dir="next"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>'
        + '</div></section>';
    }).join('');

    // Editorial "browse by category" block.
    var browse = '<section class="section section--band"><div>'
      + '<div class="section__head"><h2 class="section__title">Browse by category</h2></div>'
      + '<div class="catgrid">'
      + liveCats.map(function (c) {
          var n = recipesInCategory(c).length;
          return '<a class="cat-tile reveal" href="#/category/' + encodeURIComponent(c) + '"><span>' + esc(c) + '</span>'
            + '<span class="count">' + n + '</span></a>';
        }).join('')
      + '</div></div></section>';

    setMeta('', site.tagline || 'A warm, generous home-cooking library.');

    return chipRow + bigGrid + rails + browse;
  }

  /* ------------------------------------------------------------ all/list */

  function listPage(opts) {
    // opts: title, desc, list, showFilters, activeCat, query
    var pagehead = '<div class="pagehead">'
      + (opts.crumbs || '')
      + '<h1>' + esc(opts.title) + '</h1>'
      + (isStr(opts.desc) ? '<p>' + esc(opts.desc) + '</p>' : '')
      + '</div>';

    var filters = opts.showFilters ? filtersHtml(opts.query, opts.activeCat) : '';
    var count = '<p class="results__count" aria-live="polite">' + opts.list.length + ' recipe' + (opts.list.length === 1 ? '' : 's') + '</p>';
    var grid = '<div id="grid-host">' + gridHtml(opts.list, { emptyTitle: 'No matches', emptyMsg: 'Try clearing a filter or searching for something else.' }) + '</div>';

    return '<section class="section">' + pagehead + filters + count + grid + '</section>';
  }

  function filtersHtml(query, activeCat) {
    query = query || {};
    var cats = allCategories();
    var cat = activeCat || query.cat || '';
    var level = query.level || '';
    var time = query.time || '';
    var sort = query.sort || 'newest';

    function chip(kind, val, label, on) {
      return '<button class="chip' + (on ? ' chip--on' : '') + '" type="button" data-filter="' + kind + '" data-value="' + escAttr(val) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(label) + '</button>';
    }

    var catChips = '<div class="filters__group"><span class="filters__label">Category</span>'
      + chip('cat', '', 'All', !cat)
      + cats.map(function (c) { return chip('cat', c, c, cat === c); }).join('')
      + '</div>';

    var levelChips = '<div class="filters__group"><span class="filters__label">Level</span>'
      + ['Easy', 'Intermediate', 'Advanced'].map(function (l) { return chip('level', l, l, level === l); }).join('')
      + '</div>';

    var timeChips = '<div class="filters__group"><span class="filters__label">Time</span>'
      + chip('time', '30', '≤ 30 min', time === '30')
      + chip('time', '60', '≤ 1 hr', time === '60')
      + chip('time', '61', '1 hr +', time === '61')
      + '</div>';

    var sortSel = '<div class="filters__group"><span class="filters__label" id="sort-label">Sort</span>'
      + '<select id="sort-select" aria-labelledby="sort-label">'
      + [['newest', 'Newest'], ['top', 'Top rated'], ['quick', 'Quickest'], ['az', 'A–Z']].map(function (o) {
          return '<option value="' + o[0] + '"' + (sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('')
      + '</select></div>';

    return '<div class="filters" role="group" aria-label="Filter recipes">' + catChips + levelChips + timeChips + sortSel + '</div>';
  }

  function filterAndSort(list, query, activeCat) {
    query = query || {};
    var out = list.slice();
    var cat = activeCat || query.cat;
    if (isStr(cat)) out = out.filter(function (r) { return r.cat === cat; });
    if (isStr(query.level)) out = out.filter(function (r) { return String(r.level || '').toLowerCase() === query.level.toLowerCase(); });
    if (isStr(query.time)) {
      var t = query.time;
      out = out.filter(function (r) {
        var m = parseMinutes(r.total || r.active || r.cook);
        if (!m) return false;
        if (t === '30') return m <= 30;
        if (t === '60') return m <= 60;
        if (t === '61') return m > 60;
        return true;
      });
    }
    var sorter = SORTS[query.sort] || SORTS.newest;
    out.sort(sorter);
    return out;
  }

  function renderAll(query) {
    var list = filterAndSort(state.recipes, query, null);
    setMeta('All recipes', 'Every recipe on Recipe Mom — filter by category, level and time.');
    return listPage({
      title: 'All recipes',
      desc: 'The whole collection. Filter it down, or sort by what matters right now.',
      list: list, showFilters: true, query: query || {}
    });
  }

  function renderCategory(cat) {
    if (!isStr(cat)) return renderAll({});
    var list = filterAndSort(recipesInCategory(cat), {}, cat);
    if (!recipesInCategory(cat).length) {
      return '<section class="section"><div class="pagehead"><h1>' + esc(cat) + '</h1></div>'
        + emptyHtml('No recipes here yet', 'This category is waiting for its first recipe.', '#/recipes', 'Browse all recipes') + '</section>';
    }
    setMeta(cat, cat + ' recipes on Recipe Mom.');
    return listPage({
      title: cat,
      desc: 'Every ' + cat.toLowerCase() + ' recipe in the collection.',
      list: list, showFilters: true, activeCat: cat, query: {}
    });
  }

  function renderCollection(id) {
    var c = collectionById(id);
    if (!c) return renderAll({});
    var list = applyFilter(state.recipes, c.filter);
    list.sort(SORTS.top);
    setMeta(c.label || 'Collection', c.desc || '');
    return listPage({
      title: c.label || 'Collection',
      desc: c.desc || '',
      list: list, showFilters: false, query: {}
    });
  }

  function renderSearch(q) {
    var list = searchRecipes(q);
    setMeta('Search: ' + q, 'Search results for “' + q + '”.');
    var head = '<div class="pagehead"><h1>Search</h1>'
      + '<p>' + (isStr(q) ? list.length + ' result' + (list.length === 1 ? '' : 's') + ' for “' + esc(q) + '”' : 'Type in the search box to find a recipe.') + '</p></div>';
    var body = isStr(q)
      ? gridHtml(list, { emptyTitle: 'No results', emptyMsg: 'Nothing matched “' + q + '”. Try a simpler term.' })
      : gridHtml(state.recipes.slice(0, 12), {});
    return '<section class="section">' + head + body + '</section>';
  }

  /* ------------------------------------------------------------- recipe */

  function renderRecipe(id) {
    var r = state.byId[id];
    if (!r) {
      return '<section class="section">' + emptyHtml('Recipe not found',
        'We couldn’t find that recipe. It may have been renamed or removed.', '#/recipes', 'Browse all recipes') + '</section>';
    }

    var crumbs = '<nav class="crumbs" aria-label="Breadcrumb"><ol>'
      + '<li><a href="#/">Home</a></li>'
      + '<li><a href="#/recipes">Recipes</a></li>'
      + (isStr(r.cat) ? '<li><a href="#/category/' + encodeURIComponent(r.cat) + '">' + esc(r.cat) + '</a></li>' : '')
      + '<li aria-current="page">' + esc(r.title || '') + '</li>'
      + '</ol></nav>';

    // Image-only recipe: the picture IS the recipe (e.g. a recipe infographic).
    if (isStr(r.poster)) return posterRecipeHtml(r, crumbs);

    var media = isStr(r.img)
      ? '<img src="' + escAttr(r.img) + '" alt="' + escAttr(r.title || '') + '">'
      : '<svg viewBox="0 0 200 150" role="img" aria-label="' + escAttr(r.title || 'Recipe') + '"><use href="#' + escAttr(illRef(r)) + '"></use></svg>';

    var rt = ratingText(r.rating);
    var reviews = num(r.reviews);
    var ratingBlock = rt
      ? '<div class="recipe__rating">' + starsHtml(r.rating, '') + ' <strong>' + esc(rt) + '</strong>'
        + (reviews > 0 ? ' <span>(' + esc(reviews) + ' review' + (reviews === 1 ? '' : 's') + ')</span>' : '') + '</div>'
      : '';

    var stats = statsHtml(r);

    var lede = isStr(r.lede) ? '<p class="recipe__lede">' + esc(r.lede) + '</p>' : '';
    var eyebrow = isStr(r.author) ? '<span class="recipe__eyebrow">Recipe courtesy of ' + esc(r.author) + '</span>'
      : (isStr(r.cat) ? '<span class="recipe__eyebrow">' + esc(r.cat) + '</span>' : '');

    var actions = '<div class="recipe__actions">'
      + '<button class="btn btn--primary" type="button" id="copy-ing">Copy ingredients</button>'
      + '<button class="btn btn--ghost" type="button" id="print-recipe">Print recipe</button>'
      + '</div>';

    var hero = '<div class="recipe__hero">'
      + '<div class="recipe__head">' + eyebrow
      + '<h1 class="recipe__title">' + esc(r.title || 'Untitled recipe') + '</h1>'
      + ratingBlock + lede + actions + stats + '</div>'
      + '<figure class="recipe__media">' + media + '</figure>'
      + '</div>';

    var cols = '<div class="recipe__cols">'
      + ingredientsPanel(r)
      + directionsPanel(r)
      + '</div>';

    var extras = tipsHtml(r) + noteHtml(r) + nutritionHtml(r) + tagsHtml(r);

    var related = relatedHtml(r);

    setMeta(r.title || 'Recipe', isStr(r.desc) ? r.desc : (isStr(r.lede) ? r.lede : ''));
    injectRecipeJsonLd(r);

    return '<article class="recipe">' + crumbs + hero + cols + extras + '</article>' + related;
  }

  // ---- image-only ("poster") recipes -----------------------------------
  // The recipe is a single image — a photographed card or a designed
  // infographic. We show it large and let the reader zoom into it, rather
  // than pretending to have structured ingredients and steps.
  function posterRecipeHtml(r, crumbs) {
    var eyebrow = isStr(r.author) ? '<span class="recipe__eyebrow">Recipe courtesy of ' + esc(r.author) + '</span>'
      : (isStr(r.cat) ? '<span class="recipe__eyebrow">' + esc(r.cat) + '</span>' : '');
    var lede = isStr(r.lede) ? '<p class="recipe__lede">' + esc(r.lede) + '</p>' : '';
    var rt = ratingText(r.rating);
    var ratingBlock = rt ? '<div class="recipe__rating">' + starsHtml(r.rating, '') + ' <strong>' + esc(rt) + '</strong></div>' : '';
    var alt = (r.title ? r.title + ' — ' : '') + 'full recipe image';

    var actions = '<div class="recipe__actions">'
      + '<button class="btn btn--primary" type="button" id="poster-zoom">Zoom in</button>'
      + '<a class="btn btn--ghost" href="' + escAttr(r.poster) + '" target="_blank" rel="noopener">Open full size</a>'
      + '<button class="btn btn--ghost" type="button" id="print-recipe">Print recipe</button>'
      + '</div>';

    var head = '<div class="poster__head">' + eyebrow
      + '<h1 class="recipe__title">' + esc(r.title || 'Untitled recipe') + '</h1>'
      + ratingBlock + lede + statsHtml(r) + actions + '</div>';

    var fig = '<figure class="poster reveal">'
      + '<button class="poster__btn" type="button" id="poster-open" aria-label="Zoom into the recipe image">'
      +   '<img class="poster__img" id="poster-img" src="' + escAttr(r.poster) + '" alt="' + escAttr(alt) + '" decoding="async">'
      +   '<span class="poster__hint" aria-hidden="true">Tap to zoom</span>'
      + '</button>'
      + '</figure>';

    var extras = tipsHtml(r) + noteHtml(r) + nutritionHtml(r) + tagsHtml(r);

    setMeta(r.title || 'Recipe', isStr(r.desc) ? r.desc : (isStr(r.lede) ? r.lede : ''));
    injectRecipeJsonLd(r);

    return '<article class="recipe recipe--poster">' + crumbs + head + fig + extras + '</article>' + relatedHtml(r);
  }

  function statsHtml(r) {
    var items = [
      ['Level', r.level],
      ['Prep', r.prep],
      ['Cook', r.cook],
      ['Active', r.active],
      ['Total', r.total],
      ['Yield', r.yield || (num(r.serves) ? (r.serves + ' servings') : '')]
    ].filter(function (kv) { return isStr(kv[1]); });
    if (!items.length) return '';
    return '<ul class="recipe__stats">' + items.map(function (kv) {
      return '<li class="stat"><span class="stat__k">' + esc(kv[0]) + '</span><span class="stat__v">' + esc(kv[1]) + '</span></li>';
    }).join('') + '</ul>';
  }

  function ingredientsPanel(r) {
    var groups = arr(r.ingredientGroups).filter(Boolean);
    // Tolerate a flat `ingredients` array too.
    if (!groups.length && arr(r.ingredients).length) groups = [{ group: '', items: r.ingredients }];
    if (!groups.length) return '<aside class="ing"><h2 class="ing__title">Ingredients</h2><p class="muted">No ingredients listed.</p></aside>';

    var baseServes = num(r.serves) || 0;
    var scaler = baseServes > 0
      ? '<div class="scaler" role="group" aria-label="Adjust servings">'
        + '<span class="scaler__label">Servings</span>'
        + '<button type="button" id="serves-dec" aria-label="Fewer servings">–</button>'
        + '<output class="scaler__value" id="serves-val" aria-live="polite">' + baseServes + '</output>'
        + '<button type="button" id="serves-inc" aria-label="More servings">+</button>'
        + '</div>'
      : '';

    var units = '<div class="units" role="group" aria-label="Measurement units">'
      + '<button type="button" class="' + (state.units === 'us' ? 'is-on' : '') + '" data-units="us" aria-pressed="' + (state.units === 'us') + '">US</button>'
      + '<button type="button" class="' + (state.units === 'metric' ? 'is-on' : '') + '" data-units="metric" aria-pressed="' + (state.units === 'metric') + '">Metric</button>'
      + '</div>';

    var gid = 0, iid = 0;
    var groupsHtml = groups.map(function (g) {
      var items = arr(g && g.items).filter(Boolean);
      var head = isStr(g && g.group) ? '<p class="ing__grouphead">' + esc(g.group) + '</p>' : '';
      var lis = items.map(function (it) {
        var id = 'ing-' + gid + '-' + (iid++);
        return ingredientRow(it, id);
      }).join('');
      gid++;
      return '<div class="ing__group">' + head + '<ul>' + lis + '</ul></div>';
    }).join('');

    return '<aside class="ing" id="ingredients" data-serves="' + baseServes + '">'
      + '<h2 class="ing__title">Ingredients</h2>'
      + scaler + units
      + groupsHtml
      + '</aside>';
  }

  function ingredientRow(it, id) {
    var name = isStr(it && it.name) ? it.name : '';
    var note = isStr(it && it.note) ? '<small class="ing__note">' + esc(it.note) + '</small>' : '';
    var usQty = num(it && it.usQty), usUnit = isStr(it && it.usUnit) ? it.usUnit : '';
    var mQty = num(it && it.metricQty), mUnit = isStr(it && it.metricUnit) ? it.metricUnit : '';
    // Data attributes let the scaler/units toggle re-render the qty without a full re-render.
    var qtyText = qtyString(usQty, usUnit, mQty, mUnit, state.units, 1);
    return '<li class="ing__item" data-us-qty="' + usQty + '" data-us-unit="' + escAttr(usUnit) + '"'
      + ' data-m-qty="' + mQty + '" data-m-unit="' + escAttr(mUnit) + '">'
      + '<input class="ing__check" type="checkbox" id="' + id + '" aria-label="Mark ' + escAttr(name || 'ingredient') + ' as gathered">'
      + '<span class="ing__qty">' + esc(qtyText) + '</span>'
      + '<label class="ing__name" for="' + id + '">' + esc(name) + note + '</label>'
      + '</li>';
  }

  function qtyString(usQty, usUnit, mQty, mUnit, units, factor) {
    if (units === 'metric') {
      var mv = formatMetric(num(mQty) * factor);
      if (!mv) return '';
      return (mv + (isStr(mUnit) ? ' ' + mUnit : '')).trim();
    }
    var uv = formatUS(num(usQty) * factor);
    if (!uv) return '';
    return (uv + (isStr(usUnit) ? ' ' + usUnit : '')).trim();
  }

  function directionsPanel(r) {
    var steps = arr(r.steps).filter(Boolean);
    if (!steps.length) return '<div class="dirs"><h2 class="dirs__title">Directions</h2><p class="muted">No steps listed yet.</p></div>';
    var ol = steps.map(function (s, i) {
      var title = isStr(s && s.title) ? '<p class="step__title">' + esc(s.title) + '</p>' : '';
      var text = isStr(s && s.text) ? '<p class="step__text">' + esc(s.text) + '</p>'
        : (isStr(s) ? '<p class="step__text">' + esc(s) + '</p>' : '');
      return '<li class="step" data-step="' + i + '">'
        + '<button class="step__num" type="button" aria-label="Mark step ' + (i + 1) + ' done">' + (i + 1) + '</button>'
        + '<div>' + title + text + '</div>'
        + '</li>';
    }).join('');
    return '<div class="dirs"><h2 class="dirs__title">Directions</h2>'
      + '<ol class="dirs__steps">' + ol + '</ol></div>';
  }

  function tipsHtml(r) {
    var tips = arr(r.tips).filter(isStr);
    if (!tips.length) return '';
    return '<section class="tips"><h2>Mom’s tips</h2><ul>'
      + tips.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('')
      + '</ul></section>';
  }

  function noteHtml(r) {
    if (!isStr(r.cooksNote)) return '';
    return '<aside class="note">' + esc(r.cooksNote) + '</aside>';
  }

  function nutritionHtml(r) {
    var n = r.nutrition || {};
    var rows = [
      ['Calories', n.calories], ['Fat', n.fat], ['Carbs', n.carbs],
      ['Protein', n.protein], ['Sodium', n.sodium], ['Fiber', n.fiber]
    ].filter(function (kv) { return isStr(kv[1]); });
    if (!rows.length) return '';
    return '<section class="nutrition"><h2>Nutrition (per serving)</h2><ul>'
      + rows.map(function (kv) { return '<li><span class="stat__k">' + esc(kv[0]) + '</span><span class="stat__v">' + esc(kv[1]) + '</span></li>'; }).join('')
      + '</ul></section>';
  }

  function tagsHtml(r) {
    var tags = arr(r.tags).filter(isStr);
    if (!tags.length) return '';
    return '<div class="tagrow">' + tags.map(function (t) {
      return '<a class="tag" href="#/search?q=' + encodeURIComponent(t) + '">' + esc(t) + '</a>';
    }).join('') + '</div>';
  }

  function relatedHtml(r) {
    var rel = relatedRecipes(r, 4);
    if (!rel.length) return '';
    return '<section class="section related"><h2>You might also like</h2>'
      + '<div class="grid">' + rel.map(function (x, i) { return cardHtml(x, i + 1); }).join('') + '</div>'
      + '</section>';
  }

  function injectRecipeJsonLd(r) {
    try {
      var ingredients = [];
      arr(r.ingredientGroups).forEach(function (g) {
        arr(g && g.items).forEach(function (it) {
          if (!it) return;
          var q = qtyString(num(it.usQty), it.usUnit, num(it.metricQty), it.metricUnit, 'us', 1);
          ingredients.push((q ? q + ' ' : '') + (isStr(it.name) ? it.name : ''));
        });
      });
      var steps = arr(r.steps).filter(Boolean).map(function (s) {
        return { '@type': 'HowToStep', name: isStr(s.title) ? s.title : undefined, text: isStr(s.text) ? s.text : (isStr(s) ? s : '') };
      });
      var data = {
        '@context': 'https://schema.org', '@type': 'Recipe',
        name: r.title || 'Recipe',
        description: isStr(r.desc) ? r.desc : (isStr(r.lede) ? r.lede : undefined),
        recipeCategory: isStr(r.cat) ? r.cat : undefined,
        author: isStr(r.author) ? { '@type': 'Person', name: r.author } : undefined,
        recipeYield: isStr(r.yield) ? r.yield : (num(r.serves) ? String(r.serves) + ' servings' : undefined),
        prepTime: isoDuration(r.prep), cookTime: isoDuration(r.cook), totalTime: isoDuration(r.total),
        recipeIngredient: ingredients.length ? ingredients : undefined,
        recipeInstructions: steps.length ? steps : undefined
      };
      if (num(r.rating) > 0 && num(r.reviews) > 0) {
        data.aggregateRating = { '@type': 'AggregateRating', ratingValue: num(r.rating), reviewCount: num(r.reviews) };
      }
      var script = document.createElement('script');
      script.type = 'application/ld+json';
      script.id = 'recipe-jsonld';
      script.textContent = JSON.stringify(data, function (k, v) { return v === undefined ? undefined : v; });
      document.head.appendChild(script);
    } catch (e) { /* JSON-LD is non-critical */ }
  }

  function isoDuration(s) {
    var m = parseMinutes(s);
    if (!m) return undefined;
    var h = Math.floor(m / 60), mm = m % 60;
    return 'PT' + (h ? h + 'H' : '') + (mm ? mm + 'M' : (h ? '' : '0M'));
  }

  /* ============================================== route-level interactions */

  function wireRouteInteractions(head, parts, query) {
    // Rails on the home page.
    $$('.rail').forEach(wireRail);

    if (head === 'recipe') { wireRecipe(parts[1]); wirePoster(); }
    if (head === 'login') wireLogin();
    if (head === 'admin') wireAdmin();
    if (head === 'recipes' || head === 'category') wireFilters(head, parts, query);
  }

  function wireRail(rail) {
    var track = $('.rail__track', rail);
    if (!track) return;
    var prev = $('.rail__btn--prev', rail), next = $('.rail__btn--next', rail);
    function step(dir) {
      var amt = Math.max(track.clientWidth * 0.8, 260);
      track.scrollBy({ left: dir * amt, behavior: 'smooth' });
    }
    if (prev) prev.addEventListener('click', function () { step(-1); });
    if (next) next.addEventListener('click', function () { step(1); });
    var update = rafThrottle(function () {
      var atStart = track.scrollLeft <= 4;
      var atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
      rail.classList.toggle('is-scrolled', !atStart);
      rail.classList.toggle('is-end', atEnd);
      if (prev) prev.disabled = atStart;
      if (next) next.disabled = atEnd;
    });
    track.addEventListener('scroll', update, { passive: true });
    update();
  }

  function wireFilters(head, parts, query) {
    var section = el.app;
    // Chip clicks mutate the hash query; category route keeps its cat fixed.
    $$('.chip[data-filter]', section).forEach(function (chip) {
      chip.addEventListener('click', function () {
        var kind = chip.getAttribute('data-filter');
        var val = chip.getAttribute('data-value');
        var q = Object.assign({}, query);
        // Toggle: clicking an active value clears it.
        if (kind === 'cat') {
          if (head === 'category') {
            // Changing category navigates to the new category route.
            if (!val) { navigate('#/recipes'); return; }
            navigate('#/category/' + encodeURIComponent(val)); return;
          }
          q.cat = (q.cat === val) ? '' : val;
        } else {
          q[kind] = (q[kind] === val) ? '' : val;
        }
        pushQuery(head, parts, q);
      });
    });
    var sel = $('#sort-select', section);
    if (sel) sel.addEventListener('change', function () {
      var q = Object.assign({}, query); q.sort = sel.value;
      pushQuery(head, parts, q);
    });
  }

  function pushQuery(head, parts, q) {
    var base = head === 'category' ? '#/category/' + encodeURIComponent(parts[1] || '') : '#/recipes';
    var qs = Object.keys(q).filter(function (k) { return isStr(q[k]); }).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]);
    }).join('&');
    // Mark the grid as filtering so it animates; re-render happens on hashchange.
    var grid = $('.grid', el.app); if (grid) grid.classList.add('is-filtering');
    navigate(base + (qs ? '?' + qs : ''));
  }

  function wireRecipe(id) {
    var r = state.byId[id]; if (!r) return;

    // Ingredient tick + persistence.
    var progress = loadProgress(id);
    var ing = $('#ingredients');
    if (ing) {
      $$('.ing__item', ing).forEach(function (item, idx) {
        var cb = $('.ing__check', item);
        if (!cb) return;
        var key = 'i' + idx;
        if (progress.ing && progress.ing[key]) { cb.checked = true; item.classList.add('ing--checked'); }
        cb.addEventListener('change', function () {
          item.classList.toggle('ing--checked', cb.checked);
          progress.ing = progress.ing || {}; progress.ing[key] = cb.checked;
          saveProgress(id, progress);
        });
      });
    }

    // Step done toggle + persistence.
    $$('.step', el.app).forEach(function (step, idx) {
      var btn = $('.step__num', step);
      var key = 's' + idx;
      if (progress.steps && progress.steps[key]) step.classList.add('step--done');
      if (btn) btn.addEventListener('click', function () {
        var done = step.classList.toggle('step--done');
        progress.steps = progress.steps || {}; progress.steps[key] = done;
        saveProgress(id, progress);
      });
    });

    // Servings scaler.
    var baseServes = num(r.serves) || 0;
    if (baseServes > 0) {
      var cur = baseServes;
      var valEl = $('#serves-val');
      var dec = $('#serves-dec'), inc = $('#serves-inc');
      var applyScale = function () {
        var factor = cur / baseServes;
        if (valEl) { valEl.textContent = cur; valEl.style.animation = 'none'; void valEl.offsetWidth; valEl.style.animation = ''; }
        $$('.ing__item', el.app).forEach(function (item) {
          var q = $('.ing__qty', item);
          if (!q) return;
          var usQty = num(item.getAttribute('data-us-qty')), usUnit = item.getAttribute('data-us-unit') || '';
          var mQty = num(item.getAttribute('data-m-qty')), mUnit = item.getAttribute('data-m-unit') || '';
          q.textContent = qtyString(usQty, usUnit, mQty, mUnit, state.units, factor);
        });
        if (dec) dec.disabled = cur <= 1;
      };
      if (dec) dec.addEventListener('click', function () { cur = clamp(cur - 1, 1, 999); applyScale(); });
      if (inc) inc.addEventListener('click', function () { cur = clamp(cur + 1, 1, 999); applyScale(); });
      applyScale();
      // stash so unit toggle can reuse the factor
      state._recipeScale = function () { return cur / baseServes; };
    } else {
      state._recipeScale = function () { return 1; };
    }

    // Units toggle.
    $$('.units [data-units]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var u = btn.getAttribute('data-units');
        if (u === state.units) return;
        state.units = u;
        try { localStorage.setItem('rm-units', u); } catch (e) {}
        $$('.units [data-units]').forEach(function (b) {
          var on = b.getAttribute('data-units') === u;
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        var factor = state._recipeScale ? state._recipeScale() : 1;
        $$('.ing__item', el.app).forEach(function (item) {
          var q = $('.ing__qty', item);
          if (!q) return;
          var usQty = num(item.getAttribute('data-us-qty')), usUnit = item.getAttribute('data-us-unit') || '';
          var mQty = num(item.getAttribute('data-m-qty')), mUnit = item.getAttribute('data-m-unit') || '';
          q.textContent = qtyString(usQty, usUnit, mQty, mUnit, state.units, factor);
        });
      });
    });

    // Copy ingredients.
    var copyBtn = $('#copy-ing');
    if (copyBtn) copyBtn.addEventListener('click', function () { copyIngredients(r); });

    // Print.
    var printBtn = $('#print-recipe');
    if (printBtn) printBtn.addEventListener('click', function () { window.print(); });
  }

  function copyIngredients(r) {
    var factor = state._recipeScale ? state._recipeScale() : 1;
    var lines = [];
    lines.push(r.title || 'Recipe');
    arr(r.ingredientGroups).forEach(function (g) {
      if (isStr(g && g.group)) lines.push('', g.group + ':');
      arr(g && g.items).forEach(function (it) {
        if (!it) return;
        var q = qtyString(num(it.usQty), it.usUnit, num(it.metricQty), it.metricUnit, state.units, factor);
        lines.push('- ' + (q ? q + ' ' : '') + (isStr(it.name) ? it.name : ''));
      });
    });
    var text = lines.join('\n');
    var done = function () { toast('Ingredients copied to clipboard'); };
    var fail = function () { toast('Couldn’t copy — select and copy manually', true); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text) ? done() : fail(); });
    } else {
      legacyCopy(text) ? done() : fail();
    }
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'absolute'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  /* ============================================================ sign-in */
  // Login and the recipe manager live inside the site itself, using the same
  // header, type and buttons, so signing in does not feel like leaving.

  function apiPost(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || ('Request failed (' + r.status + ')'));
        return data;
      });
    });
  }

  function loadSession() {
    return fetch('/api/session', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) { state.session = d || { signedIn: false }; return state.session; })
      .catch(function () { state.session = { signedIn: false }; return state.session; });
  }

  function signedIn() { return !!(state.session && state.session.signedIn); }

  /* ---------------------------------------------------------- login UI */

  function renderLogin() {
    setMeta('Sign in', 'Sign in to manage Recipe Mom.');
    if (signedIn()) {
      return '<section class="section"><div class="pagehead"><h1>You are signed in</h1>'
        + '<p>Signed in as ' + esc(state.session.email) + '.</p></div>'
        + '<div class="row"><a class="btn btn--primary" href="#/admin">Go to my recipes</a>'
        + '<button class="btn btn--ghost" type="button" id="signout-btn">Sign out</button></div></section>';
    }
    return '<section class="section wrap--tight">'
      + '<div class="pagehead"><h1>Sign in</h1>'
      + '<p>Enter your email and we will send you a 6-digit code. No password to remember — '
      + 'and you only need to do this once on this device.</p></div>'
      + '<form class="authform" id="login-form" novalidate>'
      +   '<div class="authform__step" id="step-email">'
      +     '<label class="authform__label" for="login-email">Your email</label>'
      +     '<input class="authform__input" id="login-email" type="email" inputmode="email" '
      +       'autocomplete="email" placeholder="you@example.com" required>'
      +     '<button class="btn btn--primary btn--block" type="submit" id="send-code">Send me a code</button>'
      +   '</div>'
      +   '<div class="authform__step" id="step-code" hidden>'
      +     '<p class="authform__sent" id="sent-to"></p>'
      +     '<label class="authform__label" for="login-code">6-digit code</label>'
      +     '<input class="authform__input authform__input--code" id="login-code" type="text" '
      +       'inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">'
      +     '<button class="btn btn--primary btn--block" type="button" id="verify-code">Sign in</button>'
      +     '<button class="btn btn--ghost btn--block" type="button" id="back-to-email">Use a different email</button>'
      +   '</div>'
      +   '<p class="authform__msg" id="login-msg" role="status" aria-live="polite"></p>'
      + '</form>'
      + '</section>';
  }

  function wireLogin() {
    var out = $('#signout-btn');
    if (out) {
      out.addEventListener('click', function () {
        apiPost('/api/signout').then(function () {
          state.session = { signedIn: false };
          toast('Signed out');
          navigate('#/');
        });
      });
    }

    var form = $('#login-form');
    if (!form) return;
    var msg = $('#login-msg');
    var stepEmail = $('#step-email');
    var stepCode = $('#step-code');
    var emailInput = $('#login-email');
    var codeInput = $('#login-code');
    var sendBtn = $('#send-code');
    var verifyBtn = $('#verify-code');

    function say(text, isError) {
      msg.textContent = text || '';
      msg.classList.toggle('is-error', !!isError);
    }

    function requestCode() {
      var email = (emailInput.value || '').trim();
      if (!email) { say('Please enter your email.', true); emailInput.focus(); return; }
      sendBtn.disabled = true;
      say('Sending…');
      apiPost('/api/signin-request', { email: email }).then(function () {
        stepEmail.hidden = true;
        stepCode.hidden = false;
        $('#sent-to').textContent = 'We sent a code to ' + email + '. It expires in 15 minutes.';
        say('');
        codeInput.focus();
      }).catch(function (err) {
        say(err.message, true);
      }).then(function () { sendBtn.disabled = false; });
    }

    function verify() {
      var code = (codeInput.value || '').replace(/\s+/g, '');
      if (!/^\d{6}$/.test(code)) { say('Enter the 6 digits from the email.', true); codeInput.focus(); return; }
      verifyBtn.disabled = true;
      say('Checking…');
      apiPost('/api/signin-verify', { code: code }).then(function (d) {
        state.session = { signedIn: true, email: d.email };
        toast('Signed in — welcome back');
        navigate('#/admin');
      }).catch(function (err) {
        say(err.message, true);
      }).then(function () { verifyBtn.disabled = false; });
    }

    form.addEventListener('submit', function (e) { e.preventDefault(); if (!stepEmail.hidden) requestCode(); else verify(); });
    verifyBtn.addEventListener('click', verify);
    codeInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); verify(); } });
    $('#back-to-email').addEventListener('click', function () {
      stepCode.hidden = true; stepEmail.hidden = false; say(''); emailInput.focus();
    });
  }

  /* ---------------------------------------------------------- admin UI */

  function renderAdmin() {
    setMeta('My recipes', 'Add and edit recipes.');
    if (!signedIn()) {
      return '<section class="section">' + emptyHtml('Please sign in first',
        'You need to sign in before you can add or change recipes.', '#/login', 'Sign in') + '</section>';
    }

    var rows = state.recipes.map(function (r) {
      return '<li class="adminrow">'
        + '<span class="adminrow__title">' + esc(r.title || r.id) + '</span>'
        + '<span class="adminrow__cat">' + esc(r.cat || '') + '</span>'
        + '<span class="adminrow__acts">'
        +   '<a class="btn btn--ghost btn--sm" href="#/recipe/' + encodeURIComponent(r.id) + '">View</a>'
        +   '<button class="btn btn--ghost btn--sm" type="button" data-edit="' + escAttr(r.id) + '">Edit</button>'
        +   '<button class="btn btn--ghost btn--sm adminrow__del" type="button" data-del="' + escAttr(r.id) + '">Delete</button>'
        + '</span></li>';
    }).join('');

    return '<section class="section">'
      + '<div class="pagehead"><h1>My recipes</h1>'
      + '<p>Signed in as ' + esc(state.session.email) + '. Add a recipe by uploading its picture — '
      + 'the details fill in by themselves, then you check them and publish.</p></div>'
      + '<div class="row" style="margin-bottom:1.25rem">'
      +   '<button class="btn btn--primary" type="button" id="admin-new">Add a recipe</button>'
      +   '<button class="btn btn--ghost" type="button" id="signout-btn">Sign out</button>'
      + '</div>'
      + '<div id="admin-form-host"></div>'
      + '<h2 class="section__title" style="margin:2rem 0 1rem">All recipes <span class="count">'
      +   state.recipes.length + '</span></h2>'
      + '<ul class="adminlist">' + rows + '</ul>'
      + '</section>';
  }

  function adminFormHtml(recipe) {
    var r = recipe || {};
    var editing = !!recipe;
    var cats = allCategories();
    return '<form class="adminform" id="admin-form" novalidate>'
      + '<h2 class="adminform__title">' + (editing ? 'Edit “' + esc(r.title) + '”' : 'Add a recipe') + '</h2>'

      + '<div class="adminform__field">'
      +   '<label class="authform__label" for="af-image">Recipe picture</label>'
      +   '<p class="adminform__hint">Upload the recipe image. This picture becomes the recipe — '
      +     'people tap it to zoom in.' + (editing ? ' Leave empty to keep the current one.' : '') + '</p>'
      +   '<input class="adminform__file" id="af-image" type="file" accept="image/*">'
      +   '<div class="adminform__preview" id="af-preview"' + (r.poster ? '' : ' hidden') + '>'
      +     (r.poster ? '<img src="' + escAttr(r.poster) + '" alt="">' : '')
      +   '</div>'
      +   '<p class="authform__msg" id="af-imgmsg" role="status" aria-live="polite"></p>'
      + '</div>'

      + '<div class="adminform__field">'
      +   '<label class="authform__label" for="af-title">Name</label>'
      +   '<input class="authform__input" id="af-title" type="text" value="' + escAttr(r.title || '') + '" required>'
      + '</div>'

      + '<div class="adminform__row">'
      +   '<div class="adminform__field">'
      +     '<label class="authform__label" for="af-cat">Category</label>'
      +     '<select id="af-cat">' + cats.map(function (c) {
              return '<option value="' + escAttr(c) + '"' + (r.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>';
            }).join('') + '</select>'
      +   '</div>'
      +   '<div class="adminform__field">'
      +     '<label class="authform__label" for="af-total">Time <span class="muted">(optional)</span></label>'
      +     '<input class="authform__input" id="af-total" type="text" placeholder="e.g. 25 min" value="' + escAttr(r.total || '') + '">'
      +   '</div>'
      +   '<div class="adminform__field">'
      +     '<label class="authform__label" for="af-yield">Servings <span class="muted">(optional)</span></label>'
      +     '<input class="authform__input" id="af-yield" type="text" placeholder="e.g. 2 servings" value="' + escAttr(r.yield || '') + '">'
      +   '</div>'
      + '</div>'

      + '<div class="adminform__field">'
      +   '<label class="authform__label" for="af-desc">Short description</label>'
      +   '<input class="authform__input" id="af-desc" type="text" value="' + escAttr(r.desc || '') + '">'
      + '</div>'

      + '<div class="adminform__field">'
      +   '<label class="authform__label" for="af-tags">Tags <span class="muted">(separated by commas)</span></label>'
      +   '<input class="authform__input" id="af-tags" type="text" value="' + escAttr((r.tags || []).join(', ')) + '">'
      + '</div>'

      + '<input type="hidden" id="af-id" value="' + escAttr(r.id || '') + '">'
      + '<input type="hidden" id="af-ill" value="' + escAttr(r.ill || 'ill-bowl') + '">'

      + '<div class="row">'
      +   '<button class="btn btn--primary" type="submit" id="af-save">' + (editing ? 'Save changes' : 'Publish recipe') + '</button>'
      +   '<button class="btn btn--ghost" type="button" id="af-cancel">Cancel</button>'
      + '</div>'
      + '<p class="authform__msg" id="af-msg" role="status" aria-live="polite"></p>'
      + '</form>';
  }

  // Shrink on the device rather than uploading a 3 MB phone photo, and cut the
  // 4:3 card from the top so an infographic keeps its title on the card.
  function processImage(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Could not read that file.')); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('That file is not an image we can read.')); };
        img.onload = function () {
          function draw(w, h, sx, sy, sw, sh, quality) {
            var c = document.createElement('canvas');
            c.width = w; c.height = h;
            c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
            return c.toDataURL('image/jpeg', quality);
          }
          var maxW = 1400;
          var scale = Math.min(1, maxW / img.naturalWidth);
          var pw = Math.round(img.naturalWidth * scale);
          var ph = Math.round(img.naturalHeight * scale);
          var poster = draw(pw, ph, 0, 0, img.naturalWidth, img.naturalHeight, 0.9);

          var cropH = Math.min(img.naturalHeight, Math.round(img.naturalWidth * 3 / 4));
          var cw = Math.min(1200, img.naturalWidth);
          var ch = Math.round(cw * cropH / img.naturalWidth);
          var card = draw(cw, ch, 0, 0, img.naturalWidth, cropH, 0.88);

          resolve({ poster: poster, card: card });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function wireAdmin() {
    var out = $('#signout-btn');
    if (out) {
      out.addEventListener('click', function () {
        apiPost('/api/signout').then(function () {
          state.session = { signedIn: false };
          toast('Signed out');
          navigate('#/');
        });
      });
    }
    if (!signedIn()) return;

    var host = $('#admin-form-host');

    function openForm(recipe) {
      host.innerHTML = adminFormHtml(recipe);
      wireAdminForm(recipe);
      host.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    var newBtn = $('#admin-new');
    if (newBtn) newBtn.addEventListener('click', function () { openForm(null); });

    $$('[data-edit]').forEach(function (b) {
      b.addEventListener('click', function () {
        openForm(state.byId[b.getAttribute('data-edit')]);
      });
    });

    $$('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-del');
        var r = state.byId[id];
        if (!window.confirm('Delete “' + ((r && r.title) || id) + '”?\n\nIt will disappear from the site in a minute or two.')) return;
        b.disabled = true;
        apiPost('/api/recipe-delete', { id: id }).then(function () {
          toast('Deleted — the site updates in a minute');
          b.closest('.adminrow').style.opacity = '.4';
        }).catch(function (err) {
          toast(err.message, true);
          b.disabled = false;
        });
      });
    });
  }

  function wireAdminForm(recipe) {
    var pending = { poster: '', card: '' };
    var msg = $('#af-msg');
    var imgMsg = $('#af-imgmsg');

    function say(el, text, isError) {
      el.textContent = text || '';
      el.classList.toggle('is-error', !!isError);
    }

    $('#af-image').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      say(imgMsg, 'Preparing the picture…');
      processImage(file).then(function (out) {
        pending.poster = out.poster;
        pending.card = out.card;
        var prev = $('#af-preview');
        prev.hidden = false;
        prev.innerHTML = '<img src="' + out.poster + '" alt="">';
        say(imgMsg, 'Reading the picture…');
        // Ask Gemini to fill in the details so nothing has to be typed.
        return apiPost('/api/recipe-extract', {
          imageBase64: out.poster.split(',')[1],
          mimeType: 'image/jpeg'
        });
      }).then(function (d) {
        if (!d) return;
        if (!$('#af-title').value) $('#af-title').value = d.title || '';
        if (!$('#af-desc').value) $('#af-desc').value = d.desc || '';
        if (!$('#af-tags').value) $('#af-tags').value = (d.tags || []).join(', ');
        if (!$('#af-total').value) $('#af-total').value = d.total || '';
        if (!$('#af-yield').value) $('#af-yield').value = d.yield || '';
        if (d.cat) $('#af-cat').value = d.cat;
        if (d.ill) $('#af-ill').value = d.ill;
        say(imgMsg, 'Filled in from the picture — please check it below.');
      }).catch(function (err) {
        say(imgMsg, 'Picture ready. (Could not read the details automatically: ' + err.message + ')', true);
      });
    });

    $('#af-cancel').addEventListener('click', function () { $('#admin-form-host').innerHTML = ''; });

    $('#admin-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var title = $('#af-title').value.trim();
      if (!title) { say(msg, 'Please give the recipe a name.', true); return; }
      if (!recipe && !pending.poster) { say(msg, 'Please upload the recipe picture.', true); return; }

      var btn = $('#af-save');
      btn.disabled = true;
      say(msg, 'Publishing…');

      var payload = {
        recipe: {
          id: $('#af-id').value || title,
          title: title,
          cat: $('#af-cat').value,
          tags: $('#af-tags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean),
          desc: $('#af-desc').value.trim(),
          total: $('#af-total').value.trim(),
          yield: $('#af-yield').value.trim(),
          ill: $('#af-ill').value,
          badge: recipe ? (recipe.badge || '') : 'New',
          lede: (recipe && recipe.lede) || 'The whole recipe is in the picture — tap it to zoom in.',
          img: (recipe && recipe.img) || '',
          poster: (recipe && recipe.poster) || ''
        },
        originalId: recipe ? recipe.id : ''
      };
      if (pending.poster) { payload.posterBase64 = pending.poster.split(',')[1]; payload.posterMime = 'image/jpeg'; }
      if (pending.card) { payload.cardBase64 = pending.card.split(',')[1]; payload.cardMime = 'image/jpeg'; }

      apiPost('/api/recipe-save', payload).then(function (d) {
        say(msg, '');
        toast(d.created ? 'Published — live in a minute or two' : 'Saved — live in a minute or two');
        $('#admin-form-host').innerHTML = '';
      }).catch(function (err) {
        say(msg, err.message, true);
      }).then(function () { btn.disabled = false; });
    });
  }

  /* ============================================================ lightbox */
  // Zoom + pan viewer for image-only recipes. Wheel/pinch to zoom, drag to
  // pan, double-click to toggle, Esc to close. Transform-only so it stays
  // smooth on a phone, and it never traps the reader.

  var lb = { el: null, img: null, scale: 1, tx: 0, ty: 0, pointers: {}, pinch: 0, opener: null };

  function wirePoster() {
    var openBtn = $('#poster-open');
    var zoomBtn = $('#poster-zoom');
    var printBtn = $('#print-recipe');
    var img = $('#poster-img');
    if (!openBtn || !img) return;
    var open = function () { openLightbox(img.getAttribute('src'), img.getAttribute('alt'), openBtn); };

    // The poster fills the screen on a phone, so a scroll almost always starts
    // on top of it. Only treat the gesture as a tap when the finger stayed put —
    // otherwise scrolling past the image would hijack into the zoom viewer.
    var downX = 0, downY = 0, moved = false;
    openBtn.addEventListener('pointerdown', function (e) {
      downX = e.clientX; downY = e.clientY; moved = false;
    });
    openBtn.addEventListener('pointermove', function (e) {
      if (Math.abs(e.clientX - downX) > 10 || Math.abs(e.clientY - downY) > 10) moved = true;
    });
    openBtn.addEventListener('click', function (e) {
      if (moved) { e.preventDefault(); moved = false; return; }
      open();
    });

    if (zoomBtn) zoomBtn.addEventListener('click', open);
    if (printBtn) printBtn.addEventListener('click', function () { window.print(); });
  }

  function buildLightbox() {
    if (lb.el) return lb.el;
    var d = document.createElement('div');
    d.className = 'lightbox';
    d.id = 'lightbox';
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    d.setAttribute('aria-label', 'Recipe image viewer');
    d.innerHTML =
        '<div class="lightbox__backdrop" data-close="1"></div>'
      + '<div class="lightbox__stage" data-close="1"><img class="lightbox__img" alt="" draggable="false"></div>'
      + '<div class="lightbox__bar">'
      +   '<button class="lightbox__btn" type="button" data-act="out" aria-label="Zoom out">&minus;</button>'
      +   '<span class="lightbox__level" aria-live="polite">100%</span>'
      +   '<button class="lightbox__btn" type="button" data-act="in" aria-label="Zoom in">+</button>'
      +   '<button class="lightbox__btn" type="button" data-act="reset">Reset</button>'
      +   '<button class="lightbox__btn lightbox__btn--close" type="button" data-act="close" aria-label="Close viewer">Close</button>'
      + '</div>';
    document.body.appendChild(d);
    lb.el = d;
    lb.img = $('.lightbox__img', d);

    d.addEventListener('click', function (e) {
      var act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'close') return closeLightbox();
      if (act === 'in') return zoomBy(1.4);
      if (act === 'out') return zoomBy(1 / 1.4);
      if (act === 'reset') return resetZoom();
      // Tapping the empty space around an unzoomed image closes the viewer.
      if (e.target.getAttribute && e.target.getAttribute('data-close') && lb.scale <= 1.01) closeLightbox();
    });

    lb.img.addEventListener('dblclick', function (e) {
      e.preventDefault();
      if (lb.scale > 1.05) resetZoom(); else zoomAt(2.5, e.clientX, e.clientY);
    });

    d.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoomAt(lb.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
    }, { passive: false });

    d.addEventListener('pointerdown', function (e) {
      if (e.target.closest && e.target.closest('.lightbox__bar')) return;
      lb.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (Object.keys(lb.pointers).length === 2) lb.pinch = pointerDist();
      try { d.setPointerCapture(e.pointerId); } catch (err) {}
    });

    d.addEventListener('pointermove', function (e) {
      var p = lb.pointers[e.pointerId];
      if (!p) return;
      var ids = Object.keys(lb.pointers);
      if (ids.length === 2 && lb.pinch) {
        var prev = lb.pinch;
        lb.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
        var now = pointerDist();
        var a = lb.pointers[ids[0]], b = lb.pointers[ids[1]];
        if (prev > 0 && now > 0) zoomAt(lb.scale * (now / prev), (a.x + b.x) / 2, (a.y + b.y) / 2);
        lb.pinch = now;
        return;
      }
      if (lb.scale > 1.01) {
        lb.tx += e.clientX - p.x;
        lb.ty += e.clientY - p.y;
        clampPan();
        applyTransform();
      }
      lb.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    });

    var up = function (e) {
      delete lb.pointers[e.pointerId];
      if (Object.keys(lb.pointers).length < 2) lb.pinch = 0;
    };
    d.addEventListener('pointerup', up);
    d.addEventListener('pointercancel', up);

    return d;
  }

  function pointerDist() {
    var ids = Object.keys(lb.pointers);
    if (ids.length < 2) return 0;
    var a = lb.pointers[ids[0]], b = lb.pointers[ids[1]];
    return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
  }

  function applyTransform() {
    if (!lb.img) return;
    lb.img.style.transform = 'translate3d(' + lb.tx + 'px,' + lb.ty + 'px,0) scale(' + lb.scale + ')';
    lb.img.style.cursor = lb.scale > 1.01 ? 'grab' : 'zoom-in';
    var lvl = $('.lightbox__level', lb.el);
    if (lvl) lvl.textContent = Math.round(lb.scale * 100) + '%';
  }

  // Keep the image from being dragged entirely off screen.
  function clampPan() {
    if (!lb.img) return;
    var r = lb.img.getBoundingClientRect();
    var maxX = Math.max(0, (r.width - window.innerWidth) / 2 + 40);
    var maxY = Math.max(0, (r.height - window.innerHeight) / 2 + 40);
    lb.tx = clamp(lb.tx, -maxX, maxX);
    lb.ty = clamp(lb.ty, -maxY, maxY);
  }

  // Zoom keeping the point under the cursor/pinch centre put.
  function zoomAt(next, cx, cy) {
    if (!lb.img) return;
    var prev = lb.scale;
    var s = clamp(next, 1, 6);
    if (s === prev) return;
    var r = lb.img.getBoundingClientRect();
    var ox = cx - (r.left + r.width / 2);
    var oy = cy - (r.top + r.height / 2);
    var k = s / prev;
    lb.tx = lb.tx - ox * (k - 1);
    lb.ty = lb.ty - oy * (k - 1);
    lb.scale = s;
    if (s <= 1.01) { lb.tx = 0; lb.ty = 0; }
    clampPan();
    applyTransform();
  }

  function zoomBy(k) { zoomAt(lb.scale * k, window.innerWidth / 2, window.innerHeight / 2); }
  function resetZoom() { lb.scale = 1; lb.tx = 0; lb.ty = 0; applyTransform(); }

  function openLightbox(src, alt, opener) {
    var d = buildLightbox();
    lb.opener = opener || null;
    lb.img.setAttribute('src', src);
    lb.img.setAttribute('alt', alt || '');
    resetZoom();
    d.classList.add('is-open');
    document.body.classList.add('is-locked');
    var close = $('.lightbox__btn--close', d);
    if (close) close.focus();
  }

  function closeLightbox() {
    if (!lb.el) return;
    lb.el.classList.remove('is-open');
    document.body.classList.remove('is-locked');
    lb.pointers = {};
    lb.pinch = 0;
    if (lb.opener && document.contains(lb.opener)) lb.opener.focus();
  }

  function lightboxOpen() { return !!(lb.el && lb.el.classList.contains('is-open')); }

  /* ============================================================ progress */

  function loadProgress(id) {
    try { var raw = localStorage.getItem('rm-progress-' + id); return raw ? JSON.parse(raw) : {}; }
    catch (e) { return {}; }
  }
  function saveProgress(id, obj) {
    try { localStorage.setItem('rm-progress-' + id, JSON.stringify(obj)); } catch (e) {}
  }

  /* =============================================================== toasts */

  function toast(msg, isError) {
    if (!el.toastRoot) return;
    var t = document.createElement('div');
    t.className = 'toast' + (isError ? ' toast--error' : '');
    t.setAttribute('role', 'status');
    t.textContent = msg;
    el.toastRoot.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 4200);
  }

  /* ============================================================= reveal IO */

  function revealAll() {
    if (state.io) { state.io.disconnect(); }
    var targets = $$('.reveal', el.app);
    // Include the hero card region so it eases in too when on home.
    if (!('IntersectionObserver' in window)) {
      targets.forEach(function (t) { t.classList.add('reveal--in'); });
      return;
    }
    state.io = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('reveal--in');
          obs.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
    targets.forEach(function (t) { state.io.observe(t); });
    // Anything already in view on first paint should show immediately.
    requestAnimationFrame(function () {
      targets.forEach(function (t) {
        var rect = t.getBoundingClientRect();
        if (rect.top < window.innerHeight * 0.92) t.classList.add('reveal--in');
      });
    });
  }

  /* ============================================================ search UI */

  function syncSearchInput(head, query) {
    if (!el.searchInput) return;
    if (head === 'search') el.searchInput.value = query.q || '';
  }

  function buildSuggestions(q) {
    if (!isStr(q)) { hideSuggest(); return; }
    var matches = searchRecipes(q).slice(0, 7);
    state.suggestItems = matches;
    state.suggestActive = -1;
    if (!matches.length) {
      el.searchSuggest.innerHTML = '<div class="suggest__item" aria-disabled="true">No matches for “' + esc(q) + '”</div>';
      showSuggest();
      return;
    }
    var html = '<ul role="listbox">' + matches.map(function (r, i) {
      var ill = '<svg viewBox="0 0 200 150" aria-hidden="true"><use href="#' + escAttr(illRef(r)) + '"></use></svg>';
      var spic = cardImage(r);
      var thumb = spic ? '<img src="' + escAttr(spic.src) + '" alt="">' : ill;
      return '<li role="option" id="sg-' + i + '" aria-selected="false">'
        + '<a class="suggest__item" href="#/recipe/' + encodeURIComponent(r.id) + '" data-idx="' + i + '">'
        + thumb + '<span>' + highlight(r.title || '', q) + '<br><span class="suggest__cat muted">' + esc(r.cat || '') + '</span></span>'
        + '</a></li>';
    }).join('') + '</ul>';
    el.searchSuggest.innerHTML = html;
    showSuggest();
    $$('.suggest__item', el.searchSuggest).forEach(function (a) {
      a.addEventListener('click', function () { hideSuggest(); });
    });
  }

  function highlight(text, q) {
    var t = String(text);
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return esc(t);
    // Escape first, then wrap matches.
    var out = esc(t);
    terms.forEach(function (term) {
      if (!term) return;
      var re = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
      out = out.replace(re, '<mark>$1</mark>');
    });
    return out;
  }

  function showSuggest() {
    el.searchSuggest.classList.add('is-open');
    el.searchInput.setAttribute('aria-expanded', 'true');
  }
  function hideSuggest() {
    if (!el.searchSuggest) return;
    el.searchSuggest.classList.remove('is-open');
    el.searchSuggest.innerHTML = '';
    if (el.searchInput) el.searchInput.setAttribute('aria-expanded', 'false');
    state.suggestActive = -1;
  }

  function moveSuggest(dir) {
    var options = $$('#search-suggest [role="option"]');
    if (!options.length) return;
    state.suggestActive = (state.suggestActive + dir + options.length) % options.length;
    options.forEach(function (o, i) {
      var on = i === state.suggestActive;
      o.setAttribute('aria-selected', on ? 'true' : 'false');
      var a = $('.suggest__item', o); if (a) a.classList.toggle('is-active', on);
      if (on) {
        el.searchInput.setAttribute('aria-activedescendant', o.id);
        a && a.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function commitSuggest() {
    var options = $$('#search-suggest [role="option"]');
    if (state.suggestActive >= 0 && options[state.suggestActive]) {
      var a = $('.suggest__item', options[state.suggestActive]);
      if (a) { location.hash = a.getAttribute('href').slice(1); hideSuggest(); return true; }
    }
    return false;
  }

  /* ============================================================= chrome wiring */

  function isSearchOpen() {
    var h = $('#site-header');
    return !!(h && h.classList.contains('search-open'));
  }

  function openHeaderSearch() {
    var h = $('#site-header');
    if (!h) return;
    h.classList.add('search-open');
    if (el.searchToggle) el.searchToggle.setAttribute('aria-expanded', 'true');
    closeMobileNav();
    if (el.searchInput) el.searchInput.focus();
  }

  function closeHeaderSearch() {
    var h = $('#site-header');
    if (!h) return;
    h.classList.remove('search-open');
    if (el.searchToggle) el.searchToggle.setAttribute('aria-expanded', 'false');
    hideSuggest();
  }

  function wireChrome() {
    // Theme toggle.
    el.themeToggle.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      var next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      el.themeToggle.setAttribute('aria-pressed', next === 'dark' ? 'true' : 'false');
      try { localStorage.setItem('rm-theme', next); } catch (e) {}
    });
    // Reflect initial theme on the toggle.
    el.themeToggle.setAttribute('aria-pressed', document.documentElement.getAttribute('data-theme') === 'dark' ? 'true' : 'false');

    // Mobile nav.
    el.navToggle.addEventListener('click', toggleMobileNav);

    // On a phone the header has no room for a usable search field, so it
    // lives behind a magnifier and drops down full width when tapped.
    if (el.searchToggle) {
      el.searchToggle.addEventListener('click', function () {
        if (isSearchOpen()) { closeHeaderSearch(); } else { openHeaderSearch(); }
      });
    }

    // Search form.
    el.searchForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (commitSuggest()) return;
      var q = el.searchInput.value.trim();
      hideSuggest();
      closeHeaderSearch();
      navigate('#/search?q=' + encodeURIComponent(q));
      el.searchInput.blur();
    });
    var onInput = debounce(function () { buildSuggestions(el.searchInput.value.trim()); }, 150);
    el.searchInput.addEventListener('input', onInput);
    el.searchInput.addEventListener('focus', function () { if (isStr(el.searchInput.value)) buildSuggestions(el.searchInput.value.trim()); });
    el.searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSuggest(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSuggest(-1); }
      else if (e.key === 'Enter') { if (state.suggestActive >= 0) { e.preventDefault(); commitSuggest(); } }
      else if (e.key === 'Escape') { hideSuggest(); el.searchInput.blur(); }
    });

    // Close suggestions / menus on outside click.
    document.addEventListener('click', function (e) {
      if (el.searchForm && !el.searchForm.contains(e.target)) {
        hideSuggest();
        if (isSearchOpen() && el.searchToggle && !el.searchToggle.contains(e.target)) closeHeaderSearch();
      }
      if (el.navRoot && !el.navRoot.contains(e.target)) closeAllMega();
    });

    // Global keys: "/" focuses search, Esc closes things.
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && !lightboxOpen() && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !document.activeElement.isContentEditable) {
        e.preventDefault();
        if (el.searchToggle && getComputedStyle(el.searchToggle).display !== 'none') openHeaderSearch();
        el.searchInput.focus();
      } else if (e.key === 'Escape') {
        if (lightboxOpen()) { closeLightbox(); return; }
        hideSuggest(); closeAllMega(); closeMobileNav(); closeHeaderSearch();
      } else if (lightboxOpen()) {
        if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.4); }
        else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(1 / 1.4); }
        else if (e.key === '0') { e.preventDefault(); resetZoom(); }
      }
    });

    // Back to top.
    el.backToTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

    // Scroll-driven chrome: header stuck, progress bar, back-to-top.
    var onScroll = rafThrottle(function () {
      var y = window.pageYOffset || document.documentElement.scrollTop || 0;
      var h = $('#site-header'); if (h) h.classList.toggle('is-stuck', y > 40);
      el.backToTop.classList.toggle('is-visible', y > 600);
      var docH = document.documentElement.scrollHeight - window.innerHeight;
      var ratio = docH > 0 ? clamp(y / docH, 0, 1) : 0;
      el.progress.style.transform = 'scaleX(' + ratio + ')';
    });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    onScroll();
  }

  function navigate(hash) {
    if (location.hash === hash) { render(); }
    else location.hash = hash;
  }

  /* ================================================================= boot */

  function fatal(msg) {
    if (el.skeleton && el.skeleton.parentNode) el.skeleton.parentNode.removeChild(el.skeleton);
    el.app.setAttribute('aria-busy', 'false');
    el.app.innerHTML = '<section class="section">'
      + emptyHtml('Something went wrong', msg || 'The recipe data could not be loaded. Please refresh the page.')
      + '</section>';
  }

  function loadJSON(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
      return res.json();
    });
  }

  function boot() {
    try { var u = localStorage.getItem('rm-units'); if (u === 'us' || u === 'metric') state.units = u; } catch (e) {}

    Promise.all([loadJSON('site.json'), loadJSON('recipes.json')]).then(function (res) {
      state.site = res[0] || {};
      var data = res[1] || {};
      state.recipes = arr(data.recipes).filter(function (r) { return r && isStr(r.id) && isStr(r.title); });
      state.byId = {};
      state.recipes.forEach(function (r) { state.byId[r.id] = r; });

      if (!state.recipes.length) { fatal('No recipes are available yet. Add some to recipes.json to get started.'); return; }

      // Remove skeleton, reveal shell.
      if (el.skeleton && el.skeleton.parentNode) el.skeleton.parentNode.removeChild(el.skeleton);

      fillHeroCopy();
      buildHeader();
      buildFooter();
      wireChrome();

      window.addEventListener('hashchange', render);
      // Knowing whether we are signed in before the first paint keeps the
      // admin route from flashing "please sign in" to someone who is.
      loadSession().then(function () {
        buildMobileNav();
        render();
      });
    }).catch(function (err) {
      fatal('Could not load the site data (' + (err && err.message ? err.message : 'network error') + ').');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})();
