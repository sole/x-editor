(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
// CodeMirror, copyright (c) by Marijn Haverbeke and others
// Distributed under an MIT license: http://codemirror.net/LICENSE

// This is CodeMirror (http://codemirror.net), a code editor
// implemented in JavaScript on top of the browser's DOM.
//
// You can find some technical background for some of the code below
// at http://marijnhaverbeke.nl/blog/#cm-internals .

(function(mod) {
  if (typeof exports == "object" && typeof module == "object") // CommonJS
    module.exports = mod();
  else if (typeof define == "function" && define.amd) // AMD
    return define([], mod);
  else // Plain browser env
    this.CodeMirror = mod();
})(function() {
  "use strict";

  // BROWSER SNIFFING

  // Kludges for bugs and behavior differences that can't be feature
  // detected are enabled based on userAgent etc sniffing.

  var gecko = /gecko\/\d/i.test(navigator.userAgent);
  // ie_uptoN means Internet Explorer version N or lower
  var ie_upto10 = /MSIE \d/.test(navigator.userAgent);
  var ie_11up = /Trident\/(?:[7-9]|\d{2,})\..*rv:(\d+)/.exec(navigator.userAgent);
  var ie = ie_upto10 || ie_11up;
  var ie_version = ie && (ie_upto10 ? document.documentMode || 6 : ie_11up[1]);
  var webkit = /WebKit\//.test(navigator.userAgent);
  var qtwebkit = webkit && /Qt\/\d+\.\d+/.test(navigator.userAgent);
  var chrome = /Chrome\//.test(navigator.userAgent);
  var presto = /Opera\//.test(navigator.userAgent);
  var safari = /Apple Computer/.test(navigator.vendor);
  var khtml = /KHTML\//.test(navigator.userAgent);
  var mac_geMountainLion = /Mac OS X 1\d\D([8-9]|\d\d)\D/.test(navigator.userAgent);
  var phantom = /PhantomJS/.test(navigator.userAgent);

  var ios = /AppleWebKit/.test(navigator.userAgent) && /Mobile\/\w+/.test(navigator.userAgent);
  // This is woefully incomplete. Suggestions for alternative methods welcome.
  var mobile = ios || /Android|webOS|BlackBerry|Opera Mini|Opera Mobi|IEMobile/i.test(navigator.userAgent);
  var mac = ios || /Mac/.test(navigator.platform);
  var windows = /win/i.test(navigator.platform);

  var presto_version = presto && navigator.userAgent.match(/Version\/(\d*\.\d*)/);
  if (presto_version) presto_version = Number(presto_version[1]);
  if (presto_version && presto_version >= 15) { presto = false; webkit = true; }
  // Some browsers use the wrong event properties to signal cmd/ctrl on OS X
  var flipCtrlCmd = mac && (qtwebkit || presto && (presto_version == null || presto_version < 12.11));
  var captureRightClick = gecko || (ie && ie_version >= 9);

  // Optimize some code when these features are not used.
  var sawReadOnlySpans = false, sawCollapsedSpans = false;

  // EDITOR CONSTRUCTOR

  // A CodeMirror instance represents an editor. This is the object
  // that user code is usually dealing with.

  function CodeMirror(place, options) {
    if (!(this instanceof CodeMirror)) return new CodeMirror(place, options);

    this.options = options = options || {};
    // Determine effective options based on given values and defaults.
    copyObj(defaults, options, false);
    setGuttersForLineNumbers(options);

    var doc = options.value;
    if (typeof doc == "string") doc = new Doc(doc, options.mode);
    this.doc = doc;

    var display = this.display = new Display(place, doc);
    display.wrapper.CodeMirror = this;
    updateGutters(this);
    themeChanged(this);
    if (options.lineWrapping)
      this.display.wrapper.className += " CodeMirror-wrap";
    if (options.autofocus && !mobile) focusInput(this);

    this.state = {
      keyMaps: [],  // stores maps added by addKeyMap
      overlays: [], // highlighting overlays, as added by addOverlay
      modeGen: 0,   // bumped when mode/overlay changes, used to invalidate highlighting info
      overwrite: false, focused: false,
      suppressEdits: false, // used to disable editing during key handlers when in readOnly mode
      pasteIncoming: false, cutIncoming: false, // help recognize paste/cut edits in readInput
      draggingText: false,
      highlight: new Delayed() // stores highlight worker timeout
    };

    // Override magic textarea content restore that IE sometimes does
    // on our hidden textarea on reload
    if (ie && ie_version < 11) setTimeout(bind(resetInput, this, true), 20);

    registerEventHandlers(this);
    ensureGlobalHandlers();

    var cm = this;
    runInOp(this, function() {
      cm.curOp.forceUpdate = true;
      attachDoc(cm, doc);

      if ((options.autofocus && !mobile) || activeElt() == display.input)
        setTimeout(bind(onFocus, cm), 20);
      else
        onBlur(cm);

      for (var opt in optionHandlers) if (optionHandlers.hasOwnProperty(opt))
        optionHandlers[opt](cm, options[opt], Init);
      maybeUpdateLineNumberWidth(cm);
      for (var i = 0; i < initHooks.length; ++i) initHooks[i](cm);
    });
  }

  // DISPLAY CONSTRUCTOR

  // The display handles the DOM integration, both for input reading
  // and content drawing. It holds references to DOM nodes and
  // display-related state.

  function Display(place, doc) {
    var d = this;

    // The semihidden textarea that is focused when the editor is
    // focused, and receives input.
    var input = d.input = elt("textarea", null, null, "position: absolute; padding: 0; width: 1px; height: 1em; outline: none");
    // The textarea is kept positioned near the cursor to prevent the
    // fact that it'll be scrolled into view on input from scrolling
    // our fake cursor out of view. On webkit, when wrap=off, paste is
    // very slow. So make the area wide instead.
    if (webkit) input.style.width = "1000px";
    else input.setAttribute("wrap", "off");
    // If border: 0; -- iOS fails to open keyboard (issue #1287)
    if (ios) input.style.border = "1px solid black";
    input.setAttribute("autocorrect", "off"); input.setAttribute("autocapitalize", "off"); input.setAttribute("spellcheck", "false");

    // Wraps and hides input textarea
    d.inputDiv = elt("div", [input], null, "overflow: hidden; position: relative; width: 3px; height: 0px;");
    // The fake scrollbar elements.
    d.scrollbarH = elt("div", [elt("div", null, null, "height: 100%; min-height: 1px")], "CodeMirror-hscrollbar");
    d.scrollbarV = elt("div", [elt("div", null, null, "min-width: 1px")], "CodeMirror-vscrollbar");
    // Covers bottom-right square when both scrollbars are present.
    d.scrollbarFiller = elt("div", null, "CodeMirror-scrollbar-filler");
    // Covers bottom of gutter when coverGutterNextToScrollbar is on
    // and h scrollbar is present.
    d.gutterFiller = elt("div", null, "CodeMirror-gutter-filler");
    // Will contain the actual code, positioned to cover the viewport.
    d.lineDiv = elt("div", null, "CodeMirror-code");
    // Elements are added to these to represent selection and cursors.
    d.selectionDiv = elt("div", null, null, "position: relative; z-index: 1");
    d.cursorDiv = elt("div", null, "CodeMirror-cursors");
    // A visibility: hidden element used to find the size of things.
    d.measure = elt("div", null, "CodeMirror-measure");
    // When lines outside of the viewport are measured, they are drawn in this.
    d.lineMeasure = elt("div", null, "CodeMirror-measure");
    // Wraps everything that needs to exist inside the vertically-padded coordinate system
    d.lineSpace = elt("div", [d.measure, d.lineMeasure, d.selectionDiv, d.cursorDiv, d.lineDiv],
                      null, "position: relative; outline: none");
    // Moved around its parent to cover visible view.
    d.mover = elt("div", [elt("div", [d.lineSpace], "CodeMirror-lines")], null, "position: relative");
    // Set to the height of the document, allowing scrolling.
    d.sizer = elt("div", [d.mover], "CodeMirror-sizer");
    // Behavior of elts with overflow: auto and padding is
    // inconsistent across browsers. This is used to ensure the
    // scrollable area is big enough.
    d.heightForcer = elt("div", null, null, "position: absolute; height: " + scrollerCutOff + "px; width: 1px;");
    // Will contain the gutters, if any.
    d.gutters = elt("div", null, "CodeMirror-gutters");
    d.lineGutter = null;
    // Actual scrollable element.
    d.scroller = elt("div", [d.sizer, d.heightForcer, d.gutters], "CodeMirror-scroll");
    d.scroller.setAttribute("tabIndex", "-1");
    // The element in which the editor lives.
    d.wrapper = elt("div", [d.inputDiv, d.scrollbarH, d.scrollbarV,
                            d.scrollbarFiller, d.gutterFiller, d.scroller], "CodeMirror");

    // Work around IE7 z-index bug (not perfect, hence IE7 not really being supported)
    if (ie && ie_version < 8) { d.gutters.style.zIndex = -1; d.scroller.style.paddingRight = 0; }
    // Needed to hide big blue blinking cursor on Mobile Safari
    if (ios) input.style.width = "0px";
    if (!webkit) d.scroller.draggable = true;
    // Needed to handle Tab key in KHTML
    if (khtml) { d.inputDiv.style.height = "1px"; d.inputDiv.style.position = "absolute"; }
    // Need to set a minimum width to see the scrollbar on IE7 (but must not set it on IE8).
    if (ie && ie_version < 8) d.scrollbarH.style.minHeight = d.scrollbarV.style.minWidth = "18px";

    if (place.appendChild) place.appendChild(d.wrapper);
    else place(d.wrapper);

    // Current rendered range (may be bigger than the view window).
    d.viewFrom = d.viewTo = doc.first;
    // Information about the rendered lines.
    d.view = [];
    // Holds info about a single rendered line when it was rendered
    // for measurement, while not in view.
    d.externalMeasured = null;
    // Empty space (in pixels) above the view
    d.viewOffset = 0;
    d.lastSizeC = 0;
    d.updateLineNumbers = null;

    // Used to only resize the line number gutter when necessary (when
    // the amount of lines crosses a boundary that makes its width change)
    d.lineNumWidth = d.lineNumInnerWidth = d.lineNumChars = null;
    // See readInput and resetInput
    d.prevInput = "";
    // Set to true when a non-horizontal-scrolling line widget is
    // added. As an optimization, line widget aligning is skipped when
    // this is false.
    d.alignWidgets = false;
    // Flag that indicates whether we expect input to appear real soon
    // now (after some event like 'keypress' or 'input') and are
    // polling intensively.
    d.pollingFast = false;
    // Self-resetting timeout for the poller
    d.poll = new Delayed();

    d.cachedCharWidth = d.cachedTextHeight = d.cachedPaddingH = null;

    // Tracks when resetInput has punted to just putting a short
    // string into the textarea instead of the full selection.
    d.inaccurateSelection = false;

    // Tracks the maximum line length so that the horizontal scrollbar
    // can be kept static when scrolling.
    d.maxLine = null;
    d.maxLineLength = 0;
    d.maxLineChanged = false;

    // Used for measuring wheel scrolling granularity
    d.wheelDX = d.wheelDY = d.wheelStartX = d.wheelStartY = null;

    // True when shift is held down.
    d.shift = false;

    // Used to track whether anything happened since the context menu
    // was opened.
    d.selForContextMenu = null;
  }

  // STATE UPDATES

  // Used to get the editor into a consistent state again when options change.

  function loadMode(cm) {
    cm.doc.mode = CodeMirror.getMode(cm.options, cm.doc.modeOption);
    resetModeState(cm);
  }

  function resetModeState(cm) {
    cm.doc.iter(function(line) {
      if (line.stateAfter) line.stateAfter = null;
      if (line.styles) line.styles = null;
    });
    cm.doc.frontier = cm.doc.first;
    startWorker(cm, 100);
    cm.state.modeGen++;
    if (cm.curOp) regChange(cm);
  }

  function wrappingChanged(cm) {
    if (cm.options.lineWrapping) {
      addClass(cm.display.wrapper, "CodeMirror-wrap");
      cm.display.sizer.style.minWidth = "";
    } else {
      rmClass(cm.display.wrapper, "CodeMirror-wrap");
      findMaxLine(cm);
    }
    estimateLineHeights(cm);
    regChange(cm);
    clearCaches(cm);
    setTimeout(function(){updateScrollbars(cm);}, 100);
  }

  // Returns a function that estimates the height of a line, to use as
  // first approximation until the line becomes visible (and is thus
  // properly measurable).
  function estimateHeight(cm) {
    var th = textHeight(cm.display), wrapping = cm.options.lineWrapping;
    var perLine = wrapping && Math.max(5, cm.display.scroller.clientWidth / charWidth(cm.display) - 3);
    return function(line) {
      if (lineIsHidden(cm.doc, line)) return 0;

      var widgetsHeight = 0;
      if (line.widgets) for (var i = 0; i < line.widgets.length; i++) {
        if (line.widgets[i].height) widgetsHeight += line.widgets[i].height;
      }

      if (wrapping)
        return widgetsHeight + (Math.ceil(line.text.length / perLine) || 1) * th;
      else
        return widgetsHeight + th;
    };
  }

  function estimateLineHeights(cm) {
    var doc = cm.doc, est = estimateHeight(cm);
    doc.iter(function(line) {
      var estHeight = est(line);
      if (estHeight != line.height) updateLineHeight(line, estHeight);
    });
  }

  function keyMapChanged(cm) {
    var map = keyMap[cm.options.keyMap], style = map.style;
    cm.display.wrapper.className = cm.display.wrapper.className.replace(/\s*cm-keymap-\S+/g, "") +
      (style ? " cm-keymap-" + style : "");
  }

  function themeChanged(cm) {
    cm.display.wrapper.className = cm.display.wrapper.className.replace(/\s*cm-s-\S+/g, "") +
      cm.options.theme.replace(/(^|\s)\s*/g, " cm-s-");
    clearCaches(cm);
  }

  function guttersChanged(cm) {
    updateGutters(cm);
    regChange(cm);
    setTimeout(function(){alignHorizontally(cm);}, 20);
  }

  // Rebuild the gutter elements, ensure the margin to the left of the
  // code matches their width.
  function updateGutters(cm) {
    var gutters = cm.display.gutters, specs = cm.options.gutters;
    removeChildren(gutters);
    for (var i = 0; i < specs.length; ++i) {
      var gutterClass = specs[i];
      var gElt = gutters.appendChild(elt("div", null, "CodeMirror-gutter " + gutterClass));
      if (gutterClass == "CodeMirror-linenumbers") {
        cm.display.lineGutter = gElt;
        gElt.style.width = (cm.display.lineNumWidth || 1) + "px";
      }
    }
    gutters.style.display = i ? "" : "none";
    updateGutterSpace(cm);
  }

  function updateGutterSpace(cm) {
    var width = cm.display.gutters.offsetWidth;
    cm.display.sizer.style.marginLeft = width + "px";
    cm.display.scrollbarH.style.left = cm.options.fixedGutter ? width + "px" : 0;
  }

  // Compute the character length of a line, taking into account
  // collapsed ranges (see markText) that might hide parts, and join
  // other lines onto it.
  function lineLength(line) {
    if (line.height == 0) return 0;
    var len = line.text.length, merged, cur = line;
    while (merged = collapsedSpanAtStart(cur)) {
      var found = merged.find(0, true);
      cur = found.from.line;
      len += found.from.ch - found.to.ch;
    }
    cur = line;
    while (merged = collapsedSpanAtEnd(cur)) {
      var found = merged.find(0, true);
      len -= cur.text.length - found.from.ch;
      cur = found.to.line;
      len += cur.text.length - found.to.ch;
    }
    return len;
  }

  // Find the longest line in the document.
  function findMaxLine(cm) {
    var d = cm.display, doc = cm.doc;
    d.maxLine = getLine(doc, doc.first);
    d.maxLineLength = lineLength(d.maxLine);
    d.maxLineChanged = true;
    doc.iter(function(line) {
      var len = lineLength(line);
      if (len > d.maxLineLength) {
        d.maxLineLength = len;
        d.maxLine = line;
      }
    });
  }

  // Make sure the gutters options contains the element
  // "CodeMirror-linenumbers" when the lineNumbers option is true.
  function setGuttersForLineNumbers(options) {
    var found = indexOf(options.gutters, "CodeMirror-linenumbers");
    if (found == -1 && options.lineNumbers) {
      options.gutters = options.gutters.concat(["CodeMirror-linenumbers"]);
    } else if (found > -1 && !options.lineNumbers) {
      options.gutters = options.gutters.slice(0);
      options.gutters.splice(found, 1);
    }
  }

  // SCROLLBARS

  function hScrollbarTakesSpace(cm) {
    return cm.display.scroller.clientHeight - cm.display.wrapper.clientHeight < scrollerCutOff - 3;
  }

  // Prepare DOM reads needed to update the scrollbars. Done in one
  // shot to minimize update/measure roundtrips.
  function measureForScrollbars(cm) {
    var scroll = cm.display.scroller;
    return {
      clientHeight: scroll.clientHeight,
      barHeight: cm.display.scrollbarV.clientHeight,
      scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth,
      hScrollbarTakesSpace: hScrollbarTakesSpace(cm),
      barWidth: cm.display.scrollbarH.clientWidth,
      docHeight: Math.round(cm.doc.height + paddingVert(cm.display))
    };
  }

  // Re-synchronize the fake scrollbars with the actual size of the
  // content.
  function updateScrollbars(cm, measure) {
    if (!measure) measure = measureForScrollbars(cm);
    var d = cm.display, sWidth = scrollbarWidth(d.measure);
    var scrollHeight = measure.docHeight + scrollerCutOff;
    var needsH = measure.scrollWidth > measure.clientWidth;
    if (needsH && measure.scrollWidth <= measure.clientWidth + 1 &&
        sWidth > 0 && !measure.hScrollbarTakesSpace)
      needsH = false; // (Issue #2562)
    var needsV = scrollHeight > measure.clientHeight;

    if (needsV) {
      d.scrollbarV.style.display = "block";
      d.scrollbarV.style.bottom = needsH ? sWidth + "px" : "0";
      // A bug in IE8 can cause this value to be negative, so guard it.
      d.scrollbarV.firstChild.style.height =
        Math.max(0, scrollHeight - measure.clientHeight + (measure.barHeight || d.scrollbarV.clientHeight)) + "px";
    } else {
      d.scrollbarV.style.display = "";
      d.scrollbarV.firstChild.style.height = "0";
    }
    if (needsH) {
      d.scrollbarH.style.display = "block";
      d.scrollbarH.style.right = needsV ? sWidth + "px" : "0";
      d.scrollbarH.firstChild.style.width =
        (measure.scrollWidth - measure.clientWidth + (measure.barWidth || d.scrollbarH.clientWidth)) + "px";
    } else {
      d.scrollbarH.style.display = "";
      d.scrollbarH.firstChild.style.width = "0";
    }
    if (needsH && needsV) {
      d.scrollbarFiller.style.display = "block";
      d.scrollbarFiller.style.height = d.scrollbarFiller.style.width = sWidth + "px";
    } else d.scrollbarFiller.style.display = "";
    if (needsH && cm.options.coverGutterNextToScrollbar && cm.options.fixedGutter) {
      d.gutterFiller.style.display = "block";
      d.gutterFiller.style.height = sWidth + "px";
      d.gutterFiller.style.width = d.gutters.offsetWidth + "px";
    } else d.gutterFiller.style.display = "";

    if (!cm.state.checkedOverlayScrollbar && measure.clientHeight > 0) {
      if (sWidth === 0) {
        var w = mac && !mac_geMountainLion ? "12px" : "18px";
        d.scrollbarV.style.minWidth = d.scrollbarH.style.minHeight = w;
        var barMouseDown = function(e) {
          if (e_target(e) != d.scrollbarV && e_target(e) != d.scrollbarH)
            operation(cm, onMouseDown)(e);
        };
        on(d.scrollbarV, "mousedown", barMouseDown);
        on(d.scrollbarH, "mousedown", barMouseDown);
      }
      cm.state.checkedOverlayScrollbar = true;
    }
  }

  // Compute the lines that are visible in a given viewport (defaults
  // the the current scroll position). viewport may contain top,
  // height, and ensure (see op.scrollToPos) properties.
  function visibleLines(display, doc, viewport) {
    var top = viewport && viewport.top != null ? Math.max(0, viewport.top) : display.scroller.scrollTop;
    top = Math.floor(top - paddingTop(display));
    var bottom = viewport && viewport.bottom != null ? viewport.bottom : top + display.wrapper.clientHeight;

    var from = lineAtHeight(doc, top), to = lineAtHeight(doc, bottom);
    // Ensure is a {from: {line, ch}, to: {line, ch}} object, and
    // forces those lines into the viewport (if possible).
    if (viewport && viewport.ensure) {
      var ensureFrom = viewport.ensure.from.line, ensureTo = viewport.ensure.to.line;
      if (ensureFrom < from)
        return {from: ensureFrom,
                to: lineAtHeight(doc, heightAtLine(getLine(doc, ensureFrom)) + display.wrapper.clientHeight)};
      if (Math.min(ensureTo, doc.lastLine()) >= to)
        return {from: lineAtHeight(doc, heightAtLine(getLine(doc, ensureTo)) - display.wrapper.clientHeight),
                to: ensureTo};
    }
    return {from: from, to: Math.max(to, from + 1)};
  }

  // LINE NUMBERS

  // Re-align line numbers and gutter marks to compensate for
  // horizontal scrolling.
  function alignHorizontally(cm) {
    var display = cm.display, view = display.view;
    if (!display.alignWidgets && (!display.gutters.firstChild || !cm.options.fixedGutter)) return;
    var comp = compensateForHScroll(display) - display.scroller.scrollLeft + cm.doc.scrollLeft;
    var gutterW = display.gutters.offsetWidth, left = comp + "px";
    for (var i = 0; i < view.length; i++) if (!view[i].hidden) {
      if (cm.options.fixedGutter && view[i].gutter)
        view[i].gutter.style.left = left;
      var align = view[i].alignable;
      if (align) for (var j = 0; j < align.length; j++)
        align[j].style.left = left;
    }
    if (cm.options.fixedGutter)
      display.gutters.style.left = (comp + gutterW) + "px";
  }

  // Used to ensure that the line number gutter is still the right
  // size for the current document size. Returns true when an update
  // is needed.
  function maybeUpdateLineNumberWidth(cm) {
    if (!cm.options.lineNumbers) return false;
    var doc = cm.doc, last = lineNumberFor(cm.options, doc.first + doc.size - 1), display = cm.display;
    if (last.length != display.lineNumChars) {
      var test = display.measure.appendChild(elt("div", [elt("div", last)],
                                                 "CodeMirror-linenumber CodeMirror-gutter-elt"));
      var innerW = test.firstChild.offsetWidth, padding = test.offsetWidth - innerW;
      display.lineGutter.style.width = "";
      display.lineNumInnerWidth = Math.max(innerW, display.lineGutter.offsetWidth - padding);
      display.lineNumWidth = display.lineNumInnerWidth + padding;
      display.lineNumChars = display.lineNumInnerWidth ? last.length : -1;
      display.lineGutter.style.width = display.lineNumWidth + "px";
      updateGutterSpace(cm);
      return true;
    }
    return false;
  }

  function lineNumberFor(options, i) {
    return String(options.lineNumberFormatter(i + options.firstLineNumber));
  }

  // Computes display.scroller.scrollLeft + display.gutters.offsetWidth,
  // but using getBoundingClientRect to get a sub-pixel-accurate
  // result.
  function compensateForHScroll(display) {
    return display.scroller.getBoundingClientRect().left - display.sizer.getBoundingClientRect().left;
  }

  // DISPLAY DRAWING

  function DisplayUpdate(cm, viewport, force) {
    var display = cm.display;

    this.viewport = viewport;
    // Store some values that we'll need later (but don't want to force a relayout for)
    this.visible = visibleLines(display, cm.doc, viewport);
    this.editorIsHidden = !display.wrapper.offsetWidth;
    this.wrapperHeight = display.wrapper.clientHeight;
    this.oldViewFrom = display.viewFrom; this.oldViewTo = display.viewTo;
    this.oldScrollerWidth = display.scroller.clientWidth;
    this.force = force;
    this.dims = getDimensions(cm);
  }

  // Does the actual updating of the line display. Bails out
  // (returning false) when there is nothing to be done and forced is
  // false.
  function updateDisplayIfNeeded(cm, update) {
    var display = cm.display, doc = cm.doc;
    if (update.editorIsHidden) {
      resetView(cm);
      return false;
    }

    // Bail out if the visible area is already rendered and nothing changed.
    if (!update.force &&
        update.visible.from >= display.viewFrom && update.visible.to <= display.viewTo &&
        (display.updateLineNumbers == null || display.updateLineNumbers >= display.viewTo) &&
        countDirtyView(cm) == 0)
      return false;

    if (maybeUpdateLineNumberWidth(cm)) {
      resetView(cm);
      update.dims = getDimensions(cm);
    }

    // Compute a suitable new viewport (from & to)
    var end = doc.first + doc.size;
    var from = Math.max(update.visible.from - cm.options.viewportMargin, doc.first);
    var to = Math.min(end, update.visible.to + cm.options.viewportMargin);
    if (display.viewFrom < from && from - display.viewFrom < 20) from = Math.max(doc.first, display.viewFrom);
    if (display.viewTo > to && display.viewTo - to < 20) to = Math.min(end, display.viewTo);
    if (sawCollapsedSpans) {
      from = visualLineNo(cm.doc, from);
      to = visualLineEndNo(cm.doc, to);
    }

    var different = from != display.viewFrom || to != display.viewTo ||
      display.lastSizeC != update.wrapperHeight;
    adjustView(cm, from, to);

    display.viewOffset = heightAtLine(getLine(cm.doc, display.viewFrom));
    // Position the mover div to align with the current scroll position
    cm.display.mover.style.top = display.viewOffset + "px";

    var toUpdate = countDirtyView(cm);
    if (!different && toUpdate == 0 && !update.force &&
        (display.updateLineNumbers == null || display.updateLineNumbers >= display.viewTo))
      return false;

    // For big changes, we hide the enclosing element during the
    // update, since that speeds up the operations on most browsers.
    var focused = activeElt();
    if (toUpdate > 4) display.lineDiv.style.display = "none";
    patchDisplay(cm, display.updateLineNumbers, update.dims);
    if (toUpdate > 4) display.lineDiv.style.display = "";
    // There might have been a widget with a focused element that got
    // hidden or updated, if so re-focus it.
    if (focused && activeElt() != focused && focused.offsetHeight) focused.focus();

    // Prevent selection and cursors from interfering with the scroll
    // width.
    removeChildren(display.cursorDiv);
    removeChildren(display.selectionDiv);

    if (different) {
      display.lastSizeC = update.wrapperHeight;
      startWorker(cm, 400);
    }

    display.updateLineNumbers = null;

    return true;
  }

  function postUpdateDisplay(cm, update) {
    var force = update.force, viewport = update.viewport;
    for (var first = true;; first = false) {
      if (first && cm.options.lineWrapping && update.oldScrollerWidth != cm.display.scroller.clientWidth) {
        force = true;
      } else {
        force = false;
        // Clip forced viewport to actual scrollable area.
        if (viewport && viewport.top != null)
          viewport = {top: Math.min(cm.doc.height + paddingVert(cm.display) - scrollerCutOff -
                                    cm.display.scroller.clientHeight, viewport.top)};
        // Updated line heights might result in the drawn area not
        // actually covering the viewport. Keep looping until it does.
        update.visible = visibleLines(cm.display, cm.doc, viewport);
        if (update.visible.from >= cm.display.viewFrom && update.visible.to <= cm.display.viewTo)
          break;
      }
      if (!updateDisplayIfNeeded(cm, update)) break;
      updateHeightsInViewport(cm);
      var barMeasure = measureForScrollbars(cm);
      updateSelection(cm);
      setDocumentHeight(cm, barMeasure);
      updateScrollbars(cm, barMeasure);
    }

    signalLater(cm, "update", cm);
    if (cm.display.viewFrom != update.oldViewFrom || cm.display.viewTo != update.oldViewTo)
      signalLater(cm, "viewportChange", cm, cm.display.viewFrom, cm.display.viewTo);
  }

  function updateDisplaySimple(cm, viewport) {
    var update = new DisplayUpdate(cm, viewport);
    if (updateDisplayIfNeeded(cm, update)) {
      postUpdateDisplay(cm, update);
      var barMeasure = measureForScrollbars(cm);
      updateSelection(cm);
      setDocumentHeight(cm, barMeasure);
      updateScrollbars(cm, barMeasure);
    }
  }

  function setDocumentHeight(cm, measure) {
    cm.display.sizer.style.minHeight = cm.display.heightForcer.style.top = measure.docHeight + "px";
    cm.display.gutters.style.height = Math.max(measure.docHeight, measure.clientHeight - scrollerCutOff) + "px";
  }

  function checkForWebkitWidthBug(cm, measure) {
    // Work around Webkit bug where it sometimes reserves space for a
    // non-existing phantom scrollbar in the scroller (Issue #2420)
    if (cm.display.sizer.offsetWidth + cm.display.gutters.offsetWidth < cm.display.scroller.clientWidth - 1) {
      cm.display.sizer.style.minHeight = cm.display.heightForcer.style.top = "0px";
      cm.display.gutters.style.height = measure.docHeight + "px";
    }
  }

  // Read the actual heights of the rendered lines, and update their
  // stored heights to match.
  function updateHeightsInViewport(cm) {
    var display = cm.display;
    var prevBottom = display.lineDiv.offsetTop;
    for (var i = 0; i < display.view.length; i++) {
      var cur = display.view[i], height;
      if (cur.hidden) continue;
      if (ie && ie_version < 8) {
        var bot = cur.node.offsetTop + cur.node.offsetHeight;
        height = bot - prevBottom;
        prevBottom = bot;
      } else {
        var box = cur.node.getBoundingClientRect();
        height = box.bottom - box.top;
      }
      var diff = cur.line.height - height;
      if (height < 2) height = textHeight(display);
      if (diff > .001 || diff < -.001) {
        updateLineHeight(cur.line, height);
        updateWidgetHeight(cur.line);
        if (cur.rest) for (var j = 0; j < cur.rest.length; j++)
          updateWidgetHeight(cur.rest[j]);
      }
    }
  }

  // Read and store the height of line widgets associated with the
  // given line.
  function updateWidgetHeight(line) {
    if (line.widgets) for (var i = 0; i < line.widgets.length; ++i)
      line.widgets[i].height = line.widgets[i].node.offsetHeight;
  }

  // Do a bulk-read of the DOM positions and sizes needed to draw the
  // view, so that we don't interleave reading and writing to the DOM.
  function getDimensions(cm) {
    var d = cm.display, left = {}, width = {};
    for (var n = d.gutters.firstChild, i = 0; n; n = n.nextSibling, ++i) {
      left[cm.options.gutters[i]] = n.offsetLeft;
      width[cm.options.gutters[i]] = n.offsetWidth;
    }
    return {fixedPos: compensateForHScroll(d),
            gutterTotalWidth: d.gutters.offsetWidth,
            gutterLeft: left,
            gutterWidth: width,
            wrapperWidth: d.wrapper.clientWidth};
  }

  // Sync the actual display DOM structure with display.view, removing
  // nodes for lines that are no longer in view, and creating the ones
  // that are not there yet, and updating the ones that are out of
  // date.
  function patchDisplay(cm, updateNumbersFrom, dims) {
    var display = cm.display, lineNumbers = cm.options.lineNumbers;
    var container = display.lineDiv, cur = container.firstChild;

    function rm(node) {
      var next = node.nextSibling;
      // Works around a throw-scroll bug in OS X Webkit
      if (webkit && mac && cm.display.currentWheelTarget == node)
        node.style.display = "none";
      else
        node.parentNode.removeChild(node);
      return next;
    }

    var view = display.view, lineN = display.viewFrom;
    // Loop over the elements in the view, syncing cur (the DOM nodes
    // in display.lineDiv) with the view as we go.
    for (var i = 0; i < view.length; i++) {
      var lineView = view[i];
      if (lineView.hidden) {
      } else if (!lineView.node) { // Not drawn yet
        var node = buildLineElement(cm, lineView, lineN, dims);
        container.insertBefore(node, cur);
      } else { // Already drawn
        while (cur != lineView.node) cur = rm(cur);
        var updateNumber = lineNumbers && updateNumbersFrom != null &&
          updateNumbersFrom <= lineN && lineView.lineNumber;
        if (lineView.changes) {
          if (indexOf(lineView.changes, "gutter") > -1) updateNumber = false;
          updateLineForChanges(cm, lineView, lineN, dims);
        }
        if (updateNumber) {
          removeChildren(lineView.lineNumber);
          lineView.lineNumber.appendChild(document.createTextNode(lineNumberFor(cm.options, lineN)));
        }
        cur = lineView.node.nextSibling;
      }
      lineN += lineView.size;
    }
    while (cur) cur = rm(cur);
  }

  // When an aspect of a line changes, a string is added to
  // lineView.changes. This updates the relevant part of the line's
  // DOM structure.
  function updateLineForChanges(cm, lineView, lineN, dims) {
    for (var j = 0; j < lineView.changes.length; j++) {
      var type = lineView.changes[j];
      if (type == "text") updateLineText(cm, lineView);
      else if (type == "gutter") updateLineGutter(cm, lineView, lineN, dims);
      else if (type == "class") updateLineClasses(lineView);
      else if (type == "widget") updateLineWidgets(lineView, dims);
    }
    lineView.changes = null;
  }

  // Lines with gutter elements, widgets or a background class need to
  // be wrapped, and have the extra elements added to the wrapper div
  function ensureLineWrapped(lineView) {
    if (lineView.node == lineView.text) {
      lineView.node = elt("div", null, null, "position: relative");
      if (lineView.text.parentNode)
        lineView.text.parentNode.replaceChild(lineView.node, lineView.text);
      lineView.node.appendChild(lineView.text);
      if (ie && ie_version < 8) lineView.node.style.zIndex = 2;
    }
    return lineView.node;
  }

  function updateLineBackground(lineView) {
    var cls = lineView.bgClass ? lineView.bgClass + " " + (lineView.line.bgClass || "") : lineView.line.bgClass;
    if (cls) cls += " CodeMirror-linebackground";
    if (lineView.background) {
      if (cls) lineView.background.className = cls;
      else { lineView.background.parentNode.removeChild(lineView.background); lineView.background = null; }
    } else if (cls) {
      var wrap = ensureLineWrapped(lineView);
      lineView.background = wrap.insertBefore(elt("div", null, cls), wrap.firstChild);
    }
  }

  // Wrapper around buildLineContent which will reuse the structure
  // in display.externalMeasured when possible.
  function getLineContent(cm, lineView) {
    var ext = cm.display.externalMeasured;
    if (ext && ext.line == lineView.line) {
      cm.display.externalMeasured = null;
      lineView.measure = ext.measure;
      return ext.built;
    }
    return buildLineContent(cm, lineView);
  }

  // Redraw the line's text. Interacts with the background and text
  // classes because the mode may output tokens that influence these
  // classes.
  function updateLineText(cm, lineView) {
    var cls = lineView.text.className;
    var built = getLineContent(cm, lineView);
    if (lineView.text == lineView.node) lineView.node = built.pre;
    lineView.text.parentNode.replaceChild(built.pre, lineView.text);
    lineView.text = built.pre;
    if (built.bgClass != lineView.bgClass || built.textClass != lineView.textClass) {
      lineView.bgClass = built.bgClass;
      lineView.textClass = built.textClass;
      updateLineClasses(lineView);
    } else if (cls) {
      lineView.text.className = cls;
    }
  }

  function updateLineClasses(lineView) {
    updateLineBackground(lineView);
    if (lineView.line.wrapClass)
      ensureLineWrapped(lineView).className = lineView.line.wrapClass;
    else if (lineView.node != lineView.text)
      lineView.node.className = "";
    var textClass = lineView.textClass ? lineView.textClass + " " + (lineView.line.textClass || "") : lineView.line.textClass;
    lineView.text.className = textClass || "";
  }

  function updateLineGutter(cm, lineView, lineN, dims) {
    if (lineView.gutter) {
      lineView.node.removeChild(lineView.gutter);
      lineView.gutter = null;
    }
    var markers = lineView.line.gutterMarkers;
    if (cm.options.lineNumbers || markers) {
      var wrap = ensureLineWrapped(lineView);
      var gutterWrap = lineView.gutter =
        wrap.insertBefore(elt("div", null, "CodeMirror-gutter-wrapper", "position: absolute; left: " +
                              (cm.options.fixedGutter ? dims.fixedPos : -dims.gutterTotalWidth) + "px"),
                          lineView.text);
      if (cm.options.lineNumbers && (!markers || !markers["CodeMirror-linenumbers"]))
        lineView.lineNumber = gutterWrap.appendChild(
          elt("div", lineNumberFor(cm.options, lineN),
              "CodeMirror-linenumber CodeMirror-gutter-elt",
              "left: " + dims.gutterLeft["CodeMirror-linenumbers"] + "px; width: "
              + cm.display.lineNumInnerWidth + "px"));
      if (markers) for (var k = 0; k < cm.options.gutters.length; ++k) {
        var id = cm.options.gutters[k], found = markers.hasOwnProperty(id) && markers[id];
        if (found)
          gutterWrap.appendChild(elt("div", [found], "CodeMirror-gutter-elt", "left: " +
                                     dims.gutterLeft[id] + "px; width: " + dims.gutterWidth[id] + "px"));
      }
    }
  }

  function updateLineWidgets(lineView, dims) {
    if (lineView.alignable) lineView.alignable = null;
    for (var node = lineView.node.firstChild, next; node; node = next) {
      var next = node.nextSibling;
      if (node.className == "CodeMirror-linewidget")
        lineView.node.removeChild(node);
    }
    insertLineWidgets(lineView, dims);
  }

  // Build a line's DOM representation from scratch
  function buildLineElement(cm, lineView, lineN, dims) {
    var built = getLineContent(cm, lineView);
    lineView.text = lineView.node = built.pre;
    if (built.bgClass) lineView.bgClass = built.bgClass;
    if (built.textClass) lineView.textClass = built.textClass;

    updateLineClasses(lineView);
    updateLineGutter(cm, lineView, lineN, dims);
    insertLineWidgets(lineView, dims);
    return lineView.node;
  }

  // A lineView may contain multiple logical lines (when merged by
  // collapsed spans). The widgets for all of them need to be drawn.
  function insertLineWidgets(lineView, dims) {
    insertLineWidgetsFor(lineView.line, lineView, dims, true);
    if (lineView.rest) for (var i = 0; i < lineView.rest.length; i++)
      insertLineWidgetsFor(lineView.rest[i], lineView, dims, false);
  }

  function insertLineWidgetsFor(line, lineView, dims, allowAbove) {
    if (!line.widgets) return;
    var wrap = ensureLineWrapped(lineView);
    for (var i = 0, ws = line.widgets; i < ws.length; ++i) {
      var widget = ws[i], node = elt("div", [widget.node], "CodeMirror-linewidget");
      if (!widget.handleMouseEvents) node.ignoreEvents = true;
      positionLineWidget(widget, node, lineView, dims);
      if (allowAbove && widget.above)
        wrap.insertBefore(node, lineView.gutter || lineView.text);
      else
        wrap.appendChild(node);
      signalLater(widget, "redraw");
    }
  }

  function positionLineWidget(widget, node, lineView, dims) {
    if (widget.noHScroll) {
      (lineView.alignable || (lineView.alignable = [])).push(node);
      var width = dims.wrapperWidth;
      node.style.left = dims.fixedPos + "px";
      if (!widget.coverGutter) {
        width -= dims.gutterTotalWidth;
        node.style.paddingLeft = dims.gutterTotalWidth + "px";
      }
      node.style.width = width + "px";
    }
    if (widget.coverGutter) {
      node.style.zIndex = 5;
      node.style.position = "relative";
      if (!widget.noHScroll) node.style.marginLeft = -dims.gutterTotalWidth + "px";
    }
  }

  // POSITION OBJECT

  // A Pos instance represents a position within the text.
  var Pos = CodeMirror.Pos = function(line, ch) {
    if (!(this instanceof Pos)) return new Pos(line, ch);
    this.line = line; this.ch = ch;
  };

  // Compare two positions, return 0 if they are the same, a negative
  // number when a is less, and a positive number otherwise.
  var cmp = CodeMirror.cmpPos = function(a, b) { return a.line - b.line || a.ch - b.ch; };

  function copyPos(x) {return Pos(x.line, x.ch);}
  function maxPos(a, b) { return cmp(a, b) < 0 ? b : a; }
  function minPos(a, b) { return cmp(a, b) < 0 ? a : b; }

  // SELECTION / CURSOR

  // Selection objects are immutable. A new one is created every time
  // the selection changes. A selection is one or more non-overlapping
  // (and non-touching) ranges, sorted, and an integer that indicates
  // which one is the primary selection (the one that's scrolled into
  // view, that getCursor returns, etc).
  function Selection(ranges, primIndex) {
    this.ranges = ranges;
    this.primIndex = primIndex;
  }

  Selection.prototype = {
    primary: function() { return this.ranges[this.primIndex]; },
    equals: function(other) {
      if (other == this) return true;
      if (other.primIndex != this.primIndex || other.ranges.length != this.ranges.length) return false;
      for (var i = 0; i < this.ranges.length; i++) {
        var here = this.ranges[i], there = other.ranges[i];
        if (cmp(here.anchor, there.anchor) != 0 || cmp(here.head, there.head) != 0) return false;
      }
      return true;
    },
    deepCopy: function() {
      for (var out = [], i = 0; i < this.ranges.length; i++)
        out[i] = new Range(copyPos(this.ranges[i].anchor), copyPos(this.ranges[i].head));
      return new Selection(out, this.primIndex);
    },
    somethingSelected: function() {
      for (var i = 0; i < this.ranges.length; i++)
        if (!this.ranges[i].empty()) return true;
      return false;
    },
    contains: function(pos, end) {
      if (!end) end = pos;
      for (var i = 0; i < this.ranges.length; i++) {
        var range = this.ranges[i];
        if (cmp(end, range.from()) >= 0 && cmp(pos, range.to()) <= 0)
          return i;
      }
      return -1;
    }
  };

  function Range(anchor, head) {
    this.anchor = anchor; this.head = head;
  }

  Range.prototype = {
    from: function() { return minPos(this.anchor, this.head); },
    to: function() { return maxPos(this.anchor, this.head); },
    empty: function() {
      return this.head.line == this.anchor.line && this.head.ch == this.anchor.ch;
    }
  };

  // Take an unsorted, potentially overlapping set of ranges, and
  // build a selection out of it. 'Consumes' ranges array (modifying
  // it).
  function normalizeSelection(ranges, primIndex) {
    var prim = ranges[primIndex];
    ranges.sort(function(a, b) { return cmp(a.from(), b.from()); });
    primIndex = indexOf(ranges, prim);
    for (var i = 1; i < ranges.length; i++) {
      var cur = ranges[i], prev = ranges[i - 1];
      if (cmp(prev.to(), cur.from()) >= 0) {
        var from = minPos(prev.from(), cur.from()), to = maxPos(prev.to(), cur.to());
        var inv = prev.empty() ? cur.from() == cur.head : prev.from() == prev.head;
        if (i <= primIndex) --primIndex;
        ranges.splice(--i, 2, new Range(inv ? to : from, inv ? from : to));
      }
    }
    return new Selection(ranges, primIndex);
  }

  function simpleSelection(anchor, head) {
    return new Selection([new Range(anchor, head || anchor)], 0);
  }

  // Most of the external API clips given positions to make sure they
  // actually exist within the document.
  function clipLine(doc, n) {return Math.max(doc.first, Math.min(n, doc.first + doc.size - 1));}
  function clipPos(doc, pos) {
    if (pos.line < doc.first) return Pos(doc.first, 0);
    var last = doc.first + doc.size - 1;
    if (pos.line > last) return Pos(last, getLine(doc, last).text.length);
    return clipToLen(pos, getLine(doc, pos.line).text.length);
  }
  function clipToLen(pos, linelen) {
    var ch = pos.ch;
    if (ch == null || ch > linelen) return Pos(pos.line, linelen);
    else if (ch < 0) return Pos(pos.line, 0);
    else return pos;
  }
  function isLine(doc, l) {return l >= doc.first && l < doc.first + doc.size;}
  function clipPosArray(doc, array) {
    for (var out = [], i = 0; i < array.length; i++) out[i] = clipPos(doc, array[i]);
    return out;
  }

  // SELECTION UPDATES

  // The 'scroll' parameter given to many of these indicated whether
  // the new cursor position should be scrolled into view after
  // modifying the selection.

  // If shift is held or the extend flag is set, extends a range to
  // include a given position (and optionally a second position).
  // Otherwise, simply returns the range between the given positions.
  // Used for cursor motion and such.
  function extendRange(doc, range, head, other) {
    if (doc.cm && doc.cm.display.shift || doc.extend) {
      var anchor = range.anchor;
      if (other) {
        var posBefore = cmp(head, anchor) < 0;
        if (posBefore != (cmp(other, anchor) < 0)) {
          anchor = head;
          head = other;
        } else if (posBefore != (cmp(head, other) < 0)) {
          head = other;
        }
      }
      return new Range(anchor, head);
    } else {
      return new Range(other || head, head);
    }
  }

  // Extend the primary selection range, discard the rest.
  function extendSelection(doc, head, other, options) {
    setSelection(doc, new Selection([extendRange(doc, doc.sel.primary(), head, other)], 0), options);
  }

  // Extend all selections (pos is an array of selections with length
  // equal the number of selections)
  function extendSelections(doc, heads, options) {
    for (var out = [], i = 0; i < doc.sel.ranges.length; i++)
      out[i] = extendRange(doc, doc.sel.ranges[i], heads[i], null);
    var newSel = normalizeSelection(out, doc.sel.primIndex);
    setSelection(doc, newSel, options);
  }

  // Updates a single range in the selection.
  function replaceOneSelection(doc, i, range, options) {
    var ranges = doc.sel.ranges.slice(0);
    ranges[i] = range;
    setSelection(doc, normalizeSelection(ranges, doc.sel.primIndex), options);
  }

  // Reset the selection to a single range.
  function setSimpleSelection(doc, anchor, head, options) {
    setSelection(doc, simpleSelection(anchor, head), options);
  }

  // Give beforeSelectionChange handlers a change to influence a
  // selection update.
  function filterSelectionChange(doc, sel) {
    var obj = {
      ranges: sel.ranges,
      update: function(ranges) {
        this.ranges = [];
        for (var i = 0; i < ranges.length; i++)
          this.ranges[i] = new Range(clipPos(doc, ranges[i].anchor),
                                     clipPos(doc, ranges[i].head));
      }
    };
    signal(doc, "beforeSelectionChange", doc, obj);
    if (doc.cm) signal(doc.cm, "beforeSelectionChange", doc.cm, obj);
    if (obj.ranges != sel.ranges) return normalizeSelection(obj.ranges, obj.ranges.length - 1);
    else return sel;
  }

  function setSelectionReplaceHistory(doc, sel, options) {
    var done = doc.history.done, last = lst(done);
    if (last && last.ranges) {
      done[done.length - 1] = sel;
      setSelectionNoUndo(doc, sel, options);
    } else {
      setSelection(doc, sel, options);
    }
  }

  // Set a new selection.
  function setSelection(doc, sel, options) {
    setSelectionNoUndo(doc, sel, options);
    addSelectionToHistory(doc, doc.sel, doc.cm ? doc.cm.curOp.id : NaN, options);
  }

  function setSelectionNoUndo(doc, sel, options) {
    if (hasHandler(doc, "beforeSelectionChange") || doc.cm && hasHandler(doc.cm, "beforeSelectionChange"))
      sel = filterSelectionChange(doc, sel);

    var bias = options && options.bias ||
      (cmp(sel.primary().head, doc.sel.primary().head) < 0 ? -1 : 1);
    setSelectionInner(doc, skipAtomicInSelection(doc, sel, bias, true));

    if (!(options && options.scroll === false) && doc.cm)
      ensureCursorVisible(doc.cm);
  }

  function setSelectionInner(doc, sel) {
    if (sel.equals(doc.sel)) return;

    doc.sel = sel;

    if (doc.cm) {
      doc.cm.curOp.updateInput = doc.cm.curOp.selectionChanged = true;
      signalCursorActivity(doc.cm);
    }
    signalLater(doc, "cursorActivity", doc);
  }

  // Verify that the selection does not partially select any atomic
  // marked ranges.
  function reCheckSelection(doc) {
    setSelectionInner(doc, skipAtomicInSelection(doc, doc.sel, null, false), sel_dontScroll);
  }

  // Return a selection that does not partially select any atomic
  // ranges.
  function skipAtomicInSelection(doc, sel, bias, mayClear) {
    var out;
    for (var i = 0; i < sel.ranges.length; i++) {
      var range = sel.ranges[i];
      var newAnchor = skipAtomic(doc, range.anchor, bias, mayClear);
      var newHead = skipAtomic(doc, range.head, bias, mayClear);
      if (out || newAnchor != range.anchor || newHead != range.head) {
        if (!out) out = sel.ranges.slice(0, i);
        out[i] = new Range(newAnchor, newHead);
      }
    }
    return out ? normalizeSelection(out, sel.primIndex) : sel;
  }

  // Ensure a given position is not inside an atomic range.
  function skipAtomic(doc, pos, bias, mayClear) {
    var flipped = false, curPos = pos;
    var dir = bias || 1;
    doc.cantEdit = false;
    search: for (;;) {
      var line = getLine(doc, curPos.line);
      if (line.markedSpans) {
        for (var i = 0; i < line.markedSpans.length; ++i) {
          var sp = line.markedSpans[i], m = sp.marker;
          if ((sp.from == null || (m.inclusiveLeft ? sp.from <= curPos.ch : sp.from < curPos.ch)) &&
              (sp.to == null || (m.inclusiveRight ? sp.to >= curPos.ch : sp.to > curPos.ch))) {
            if (mayClear) {
              signal(m, "beforeCursorEnter");
              if (m.explicitlyCleared) {
                if (!line.markedSpans) break;
                else {--i; continue;}
              }
            }
            if (!m.atomic) continue;
            var newPos = m.find(dir < 0 ? -1 : 1);
            if (cmp(newPos, curPos) == 0) {
              newPos.ch += dir;
              if (newPos.ch < 0) {
                if (newPos.line > doc.first) newPos = clipPos(doc, Pos(newPos.line - 1));
                else newPos = null;
              } else if (newPos.ch > line.text.length) {
                if (newPos.line < doc.first + doc.size - 1) newPos = Pos(newPos.line + 1, 0);
                else newPos = null;
              }
              if (!newPos) {
                if (flipped) {
                  // Driven in a corner -- no valid cursor position found at all
                  // -- try again *with* clearing, if we didn't already
                  if (!mayClear) return skipAtomic(doc, pos, bias, true);
                  // Otherwise, turn off editing until further notice, and return the start of the doc
                  doc.cantEdit = true;
                  return Pos(doc.first, 0);
                }
                flipped = true; newPos = pos; dir = -dir;
              }
            }
            curPos = newPos;
            continue search;
          }
        }
      }
      return curPos;
    }
  }

  // SELECTION DRAWING

  // Redraw the selection and/or cursor
  function drawSelection(cm) {
    var display = cm.display, doc = cm.doc, result = {};
    var curFragment = result.cursors = document.createDocumentFragment();
    var selFragment = result.selection = document.createDocumentFragment();

    for (var i = 0; i < doc.sel.ranges.length; i++) {
      var range = doc.sel.ranges[i];
      var collapsed = range.empty();
      if (collapsed || cm.options.showCursorWhenSelecting)
        drawSelectionCursor(cm, range, curFragment);
      if (!collapsed)
        drawSelectionRange(cm, range, selFragment);
    }

    // Move the hidden textarea near the cursor to prevent scrolling artifacts
    if (cm.options.moveInputWithCursor) {
      var headPos = cursorCoords(cm, doc.sel.primary().head, "div");
      var wrapOff = display.wrapper.getBoundingClientRect(), lineOff = display.lineDiv.getBoundingClientRect();
      result.teTop = Math.max(0, Math.min(display.wrapper.clientHeight - 10,
                                          headPos.top + lineOff.top - wrapOff.top));
      result.teLeft = Math.max(0, Math.min(display.wrapper.clientWidth - 10,
                                           headPos.left + lineOff.left - wrapOff.left));
    }

    return result;
  }

  function updateSelection(cm, drawn) {
    if (!drawn) drawn = drawSelection(cm);
    removeChildrenAndAdd(cm.display.cursorDiv, drawn.cursors);
    removeChildrenAndAdd(cm.display.selectionDiv, drawn.selection);
    if (drawn.teTop != null) {
      cm.display.inputDiv.style.top = drawn.teTop + "px";
      cm.display.inputDiv.style.left = drawn.teLeft + "px";
    }
  }

  // Draws a cursor for the given range
  function drawSelectionCursor(cm, range, output) {
    var pos = cursorCoords(cm, range.head, "div", null, null, !cm.options.singleCursorHeightPerLine);

    var cursor = output.appendChild(elt("div", "\u00a0", "CodeMirror-cursor"));
    cursor.style.left = pos.left + "px";
    cursor.style.top = pos.top + "px";
    cursor.style.height = Math.max(0, pos.bottom - pos.top) * cm.options.cursorHeight + "px";

    if (pos.other) {
      // Secondary cursor, shown when on a 'jump' in bi-directional text
      var otherCursor = output.appendChild(elt("div", "\u00a0", "CodeMirror-cursor CodeMirror-secondarycursor"));
      otherCursor.style.display = "";
      otherCursor.style.left = pos.other.left + "px";
      otherCursor.style.top = pos.other.top + "px";
      otherCursor.style.height = (pos.other.bottom - pos.other.top) * .85 + "px";
    }
  }

  // Draws the given range as a highlighted selection
  function drawSelectionRange(cm, range, output) {
    var display = cm.display, doc = cm.doc;
    var fragment = document.createDocumentFragment();
    var padding = paddingH(cm.display), leftSide = padding.left, rightSide = display.lineSpace.offsetWidth - padding.right;

    function add(left, top, width, bottom) {
      if (top < 0) top = 0;
      top = Math.round(top);
      bottom = Math.round(bottom);
      fragment.appendChild(elt("div", null, "CodeMirror-selected", "position: absolute; left: " + left +
                               "px; top: " + top + "px; width: " + (width == null ? rightSide - left : width) +
                               "px; height: " + (bottom - top) + "px"));
    }

    function drawForLine(line, fromArg, toArg) {
      var lineObj = getLine(doc, line);
      var lineLen = lineObj.text.length;
      var start, end;
      function coords(ch, bias) {
        return charCoords(cm, Pos(line, ch), "div", lineObj, bias);
      }

      iterateBidiSections(getOrder(lineObj), fromArg || 0, toArg == null ? lineLen : toArg, function(from, to, dir) {
        var leftPos = coords(from, "left"), rightPos, left, right;
        if (from == to) {
          rightPos = leftPos;
          left = right = leftPos.left;
        } else {
          rightPos = coords(to - 1, "right");
          if (dir == "rtl") { var tmp = leftPos; leftPos = rightPos; rightPos = tmp; }
          left = leftPos.left;
          right = rightPos.right;
        }
        if (fromArg == null && from == 0) left = leftSide;
        if (rightPos.top - leftPos.top > 3) { // Different lines, draw top part
          add(left, leftPos.top, null, leftPos.bottom);
          left = leftSide;
          if (leftPos.bottom < rightPos.top) add(left, leftPos.bottom, null, rightPos.top);
        }
        if (toArg == null && to == lineLen) right = rightSide;
        if (!start || leftPos.top < start.top || leftPos.top == start.top && leftPos.left < start.left)
          start = leftPos;
        if (!end || rightPos.bottom > end.bottom || rightPos.bottom == end.bottom && rightPos.right > end.right)
          end = rightPos;
        if (left < leftSide + 1) left = leftSide;
        add(left, rightPos.top, right - left, rightPos.bottom);
      });
      return {start: start, end: end};
    }

    var sFrom = range.from(), sTo = range.to();
    if (sFrom.line == sTo.line) {
      drawForLine(sFrom.line, sFrom.ch, sTo.ch);
    } else {
      var fromLine = getLine(doc, sFrom.line), toLine = getLine(doc, sTo.line);
      var singleVLine = visualLine(fromLine) == visualLine(toLine);
      var leftEnd = drawForLine(sFrom.line, sFrom.ch, singleVLine ? fromLine.text.length + 1 : null).end;
      var rightStart = drawForLine(sTo.line, singleVLine ? 0 : null, sTo.ch).start;
      if (singleVLine) {
        if (leftEnd.top < rightStart.top - 2) {
          add(leftEnd.right, leftEnd.top, null, leftEnd.bottom);
          add(leftSide, rightStart.top, rightStart.left, rightStart.bottom);
        } else {
          add(leftEnd.right, leftEnd.top, rightStart.left - leftEnd.right, leftEnd.bottom);
        }
      }
      if (leftEnd.bottom < rightStart.top)
        add(leftSide, leftEnd.bottom, null, rightStart.top);
    }

    output.appendChild(fragment);
  }

  // Cursor-blinking
  function restartBlink(cm) {
    if (!cm.state.focused) return;
    var display = cm.display;
    clearInterval(display.blinker);
    var on = true;
    display.cursorDiv.style.visibility = "";
    if (cm.options.cursorBlinkRate > 0)
      display.blinker = setInterval(function() {
        display.cursorDiv.style.visibility = (on = !on) ? "" : "hidden";
      }, cm.options.cursorBlinkRate);
    else if (cm.options.cursorBlinkRate < 0)
      display.cursorDiv.style.visibility = "hidden";
  }

  // HIGHLIGHT WORKER

  function startWorker(cm, time) {
    if (cm.doc.mode.startState && cm.doc.frontier < cm.display.viewTo)
      cm.state.highlight.set(time, bind(highlightWorker, cm));
  }

  function highlightWorker(cm) {
    var doc = cm.doc;
    if (doc.frontier < doc.first) doc.frontier = doc.first;
    if (doc.frontier >= cm.display.viewTo) return;
    var end = +new Date + cm.options.workTime;
    var state = copyState(doc.mode, getStateBefore(cm, doc.frontier));
    var changedLines = [];

    doc.iter(doc.frontier, Math.min(doc.first + doc.size, cm.display.viewTo + 500), function(line) {
      if (doc.frontier >= cm.display.viewFrom) { // Visible
        var oldStyles = line.styles;
        var highlighted = highlightLine(cm, line, state, true);
        line.styles = highlighted.styles;
        var oldCls = line.styleClasses, newCls = highlighted.classes;
        if (newCls) line.styleClasses = newCls;
        else if (oldCls) line.styleClasses = null;
        var ischange = !oldStyles || oldStyles.length != line.styles.length ||
          oldCls != newCls && (!oldCls || !newCls || oldCls.bgClass != newCls.bgClass || oldCls.textClass != newCls.textClass);
        for (var i = 0; !ischange && i < oldStyles.length; ++i) ischange = oldStyles[i] != line.styles[i];
        if (ischange) changedLines.push(doc.frontier);
        line.stateAfter = copyState(doc.mode, state);
      } else {
        processLine(cm, line.text, state);
        line.stateAfter = doc.frontier % 5 == 0 ? copyState(doc.mode, state) : null;
      }
      ++doc.frontier;
      if (+new Date > end) {
        startWorker(cm, cm.options.workDelay);
        return true;
      }
    });
    if (changedLines.length) runInOp(cm, function() {
      for (var i = 0; i < changedLines.length; i++)
        regLineChange(cm, changedLines[i], "text");
    });
  }

  // Finds the line to start with when starting a parse. Tries to
  // find a line with a stateAfter, so that it can start with a
  // valid state. If that fails, it returns the line with the
  // smallest indentation, which tends to need the least context to
  // parse correctly.
  function findStartLine(cm, n, precise) {
    var minindent, minline, doc = cm.doc;
    var lim = precise ? -1 : n - (cm.doc.mode.innerMode ? 1000 : 100);
    for (var search = n; search > lim; --search) {
      if (search <= doc.first) return doc.first;
      var line = getLine(doc, search - 1);
      if (line.stateAfter && (!precise || search <= doc.frontier)) return search;
      var indented = countColumn(line.text, null, cm.options.tabSize);
      if (minline == null || minindent > indented) {
        minline = search - 1;
        minindent = indented;
      }
    }
    return minline;
  }

  function getStateBefore(cm, n, precise) {
    var doc = cm.doc, display = cm.display;
    if (!doc.mode.startState) return true;
    var pos = findStartLine(cm, n, precise), state = pos > doc.first && getLine(doc, pos-1).stateAfter;
    if (!state) state = startState(doc.mode);
    else state = copyState(doc.mode, state);
    doc.iter(pos, n, function(line) {
      processLine(cm, line.text, state);
      var save = pos == n - 1 || pos % 5 == 0 || pos >= display.viewFrom && pos < display.viewTo;
      line.stateAfter = save ? copyState(doc.mode, state) : null;
      ++pos;
    });
    if (precise) doc.frontier = pos;
    return state;
  }

  // POSITION MEASUREMENT

  function paddingTop(display) {return display.lineSpace.offsetTop;}
  function paddingVert(display) {return display.mover.offsetHeight - display.lineSpace.offsetHeight;}
  function paddingH(display) {
    if (display.cachedPaddingH) return display.cachedPaddingH;
    var e = removeChildrenAndAdd(display.measure, elt("pre", "x"));
    var style = window.getComputedStyle ? window.getComputedStyle(e) : e.currentStyle;
    var data = {left: parseInt(style.paddingLeft), right: parseInt(style.paddingRight)};
    if (!isNaN(data.left) && !isNaN(data.right)) display.cachedPaddingH = data;
    return data;
  }

  // Ensure the lineView.wrapping.heights array is populated. This is
  // an array of bottom offsets for the lines that make up a drawn
  // line. When lineWrapping is on, there might be more than one
  // height.
  function ensureLineHeights(cm, lineView, rect) {
    var wrapping = cm.options.lineWrapping;
    var curWidth = wrapping && cm.display.scroller.clientWidth;
    if (!lineView.measure.heights || wrapping && lineView.measure.width != curWidth) {
      var heights = lineView.measure.heights = [];
      if (wrapping) {
        lineView.measure.width = curWidth;
        var rects = lineView.text.firstChild.getClientRects();
        for (var i = 0; i < rects.length - 1; i++) {
          var cur = rects[i], next = rects[i + 1];
          if (Math.abs(cur.bottom - next.bottom) > 2)
            heights.push((cur.bottom + next.top) / 2 - rect.top);
        }
      }
      heights.push(rect.bottom - rect.top);
    }
  }

  // Find a line map (mapping character offsets to text nodes) and a
  // measurement cache for the given line number. (A line view might
  // contain multiple lines when collapsed ranges are present.)
  function mapFromLineView(lineView, line, lineN) {
    if (lineView.line == line)
      return {map: lineView.measure.map, cache: lineView.measure.cache};
    for (var i = 0; i < lineView.rest.length; i++)
      if (lineView.rest[i] == line)
        return {map: lineView.measure.maps[i], cache: lineView.measure.caches[i]};
    for (var i = 0; i < lineView.rest.length; i++)
      if (lineNo(lineView.rest[i]) > lineN)
        return {map: lineView.measure.maps[i], cache: lineView.measure.caches[i], before: true};
  }

  // Render a line into the hidden node display.externalMeasured. Used
  // when measurement is needed for a line that's not in the viewport.
  function updateExternalMeasurement(cm, line) {
    line = visualLine(line);
    var lineN = lineNo(line);
    var view = cm.display.externalMeasured = new LineView(cm.doc, line, lineN);
    view.lineN = lineN;
    var built = view.built = buildLineContent(cm, view);
    view.text = built.pre;
    removeChildrenAndAdd(cm.display.lineMeasure, built.pre);
    return view;
  }

  // Get a {top, bottom, left, right} box (in line-local coordinates)
  // for a given character.
  function measureChar(cm, line, ch, bias) {
    return measureCharPrepared(cm, prepareMeasureForLine(cm, line), ch, bias);
  }

  // Find a line view that corresponds to the given line number.
  function findViewForLine(cm, lineN) {
    if (lineN >= cm.display.viewFrom && lineN < cm.display.viewTo)
      return cm.display.view[findViewIndex(cm, lineN)];
    var ext = cm.display.externalMeasured;
    if (ext && lineN >= ext.lineN && lineN < ext.lineN + ext.size)
      return ext;
  }

  // Measurement can be split in two steps, the set-up work that
  // applies to the whole line, and the measurement of the actual
  // character. Functions like coordsChar, that need to do a lot of
  // measurements in a row, can thus ensure that the set-up work is
  // only done once.
  function prepareMeasureForLine(cm, line) {
    var lineN = lineNo(line);
    var view = findViewForLine(cm, lineN);
    if (view && !view.text)
      view = null;
    else if (view && view.changes)
      updateLineForChanges(cm, view, lineN, getDimensions(cm));
    if (!view)
      view = updateExternalMeasurement(cm, line);

    var info = mapFromLineView(view, line, lineN);
    return {
      line: line, view: view, rect: null,
      map: info.map, cache: info.cache, before: info.before,
      hasHeights: false
    };
  }

  // Given a prepared measurement object, measures the position of an
  // actual character (or fetches it from the cache).
  function measureCharPrepared(cm, prepared, ch, bias, varHeight) {
    if (prepared.before) ch = -1;
    var key = ch + (bias || ""), found;
    if (prepared.cache.hasOwnProperty(key)) {
      found = prepared.cache[key];
    } else {
      if (!prepared.rect)
        prepared.rect = prepared.view.text.getBoundingClientRect();
      if (!prepared.hasHeights) {
        ensureLineHeights(cm, prepared.view, prepared.rect);
        prepared.hasHeights = true;
      }
      found = measureCharInner(cm, prepared, ch, bias);
      if (!found.bogus) prepared.cache[key] = found;
    }
    return {left: found.left, right: found.right,
            top: varHeight ? found.rtop : found.top,
            bottom: varHeight ? found.rbottom : found.bottom};
  }

  var nullRect = {left: 0, right: 0, top: 0, bottom: 0};

  function measureCharInner(cm, prepared, ch, bias) {
    var map = prepared.map;

    var node, start, end, collapse;
    // First, search the line map for the text node corresponding to,
    // or closest to, the target character.
    for (var i = 0; i < map.length; i += 3) {
      var mStart = map[i], mEnd = map[i + 1];
      if (ch < mStart) {
        start = 0; end = 1;
        collapse = "left";
      } else if (ch < mEnd) {
        start = ch - mStart;
        end = start + 1;
      } else if (i == map.length - 3 || ch == mEnd && map[i + 3] > ch) {
        end = mEnd - mStart;
        start = end - 1;
        if (ch >= mEnd) collapse = "right";
      }
      if (start != null) {
        node = map[i + 2];
        if (mStart == mEnd && bias == (node.insertLeft ? "left" : "right"))
          collapse = bias;
        if (bias == "left" && start == 0)
          while (i && map[i - 2] == map[i - 3] && map[i - 1].insertLeft) {
            node = map[(i -= 3) + 2];
            collapse = "left";
          }
        if (bias == "right" && start == mEnd - mStart)
          while (i < map.length - 3 && map[i + 3] == map[i + 4] && !map[i + 5].insertLeft) {
            node = map[(i += 3) + 2];
            collapse = "right";
          }
        break;
      }
    }

    var rect;
    if (node.nodeType == 3) { // If it is a text node, use a range to retrieve the coordinates.
      while (start && isExtendingChar(prepared.line.text.charAt(mStart + start))) --start;
      while (mStart + end < mEnd && isExtendingChar(prepared.line.text.charAt(mStart + end))) ++end;
      if (ie && ie_version < 9 && start == 0 && end == mEnd - mStart) {
        rect = node.parentNode.getBoundingClientRect();
      } else if (ie && cm.options.lineWrapping) {
        var rects = range(node, start, end).getClientRects();
        if (rects.length)
          rect = rects[bias == "right" ? rects.length - 1 : 0];
        else
          rect = nullRect;
      } else {
        rect = range(node, start, end).getBoundingClientRect() || nullRect;
      }
    } else { // If it is a widget, simply get the box for the whole widget.
      if (start > 0) collapse = bias = "right";
      var rects;
      if (cm.options.lineWrapping && (rects = node.getClientRects()).length > 1)
        rect = rects[bias == "right" ? rects.length - 1 : 0];
      else
        rect = node.getBoundingClientRect();
    }
    if (ie && ie_version < 9 && !start && (!rect || !rect.left && !rect.right)) {
      var rSpan = node.parentNode.getClientRects()[0];
      if (rSpan)
        rect = {left: rSpan.left, right: rSpan.left + charWidth(cm.display), top: rSpan.top, bottom: rSpan.bottom};
      else
        rect = nullRect;
    }

    if (ie && ie_version < 11) rect = maybeUpdateRectForZooming(cm.display.measure, rect);

    var rtop = rect.top - prepared.rect.top, rbot = rect.bottom - prepared.rect.top;
    var mid = (rtop + rbot) / 2;
    var heights = prepared.view.measure.heights;
    for (var i = 0; i < heights.length - 1; i++)
      if (mid < heights[i]) break;
    var top = i ? heights[i - 1] : 0, bot = heights[i];
    var result = {left: (collapse == "right" ? rect.right : rect.left) - prepared.rect.left,
                  right: (collapse == "left" ? rect.left : rect.right) - prepared.rect.left,
                  top: top, bottom: bot};
    if (!rect.left && !rect.right) result.bogus = true;
    if (!cm.options.singleCursorHeightPerLine) { result.rtop = rtop; result.rbottom = rbot; }

    return result;
  }

  // Work around problem with bounding client rects on ranges being
  // returned incorrectly when zoomed on IE10 and below.
  function maybeUpdateRectForZooming(measure, rect) {
    if (!window.screen || screen.logicalXDPI == null ||
        screen.logicalXDPI == screen.deviceXDPI || !hasBadZoomedRects(measure))
      return rect;
    var scaleX = screen.logicalXDPI / screen.deviceXDPI;
    var scaleY = screen.logicalYDPI / screen.deviceYDPI;
    return {left: rect.left * scaleX, right: rect.right * scaleX,
            top: rect.top * scaleY, bottom: rect.bottom * scaleY};
  }

  function clearLineMeasurementCacheFor(lineView) {
    if (lineView.measure) {
      lineView.measure.cache = {};
      lineView.measure.heights = null;
      if (lineView.rest) for (var i = 0; i < lineView.rest.length; i++)
        lineView.measure.caches[i] = {};
    }
  }

  function clearLineMeasurementCache(cm) {
    cm.display.externalMeasure = null;
    removeChildren(cm.display.lineMeasure);
    for (var i = 0; i < cm.display.view.length; i++)
      clearLineMeasurementCacheFor(cm.display.view[i]);
  }

  function clearCaches(cm) {
    clearLineMeasurementCache(cm);
    cm.display.cachedCharWidth = cm.display.cachedTextHeight = cm.display.cachedPaddingH = null;
    if (!cm.options.lineWrapping) cm.display.maxLineChanged = true;
    cm.display.lineNumChars = null;
  }

  function pageScrollX() { return window.pageXOffset || (document.documentElement || document.body).scrollLeft; }
  function pageScrollY() { return window.pageYOffset || (document.documentElement || document.body).scrollTop; }

  // Converts a {top, bottom, left, right} box from line-local
  // coordinates into another coordinate system. Context may be one of
  // "line", "div" (display.lineDiv), "local"/null (editor), or "page".
  function intoCoordSystem(cm, lineObj, rect, context) {
    if (lineObj.widgets) for (var i = 0; i < lineObj.widgets.length; ++i) if (lineObj.widgets[i].above) {
      var size = widgetHeight(lineObj.widgets[i]);
      rect.top += size; rect.bottom += size;
    }
    if (context == "line") return rect;
    if (!context) context = "local";
    var yOff = heightAtLine(lineObj);
    if (context == "local") yOff += paddingTop(cm.display);
    else yOff -= cm.display.viewOffset;
    if (context == "page" || context == "window") {
      var lOff = cm.display.lineSpace.getBoundingClientRect();
      yOff += lOff.top + (context == "window" ? 0 : pageScrollY());
      var xOff = lOff.left + (context == "window" ? 0 : pageScrollX());
      rect.left += xOff; rect.right += xOff;
    }
    rect.top += yOff; rect.bottom += yOff;
    return rect;
  }

  // Coverts a box from "div" coords to another coordinate system.
  // Context may be "window", "page", "div", or "local"/null.
  function fromCoordSystem(cm, coords, context) {
    if (context == "div") return coords;
    var left = coords.left, top = coords.top;
    // First move into "page" coordinate system
    if (context == "page") {
      left -= pageScrollX();
      top -= pageScrollY();
    } else if (context == "local" || !context) {
      var localBox = cm.display.sizer.getBoundingClientRect();
      left += localBox.left;
      top += localBox.top;
    }

    var lineSpaceBox = cm.display.lineSpace.getBoundingClientRect();
    return {left: left - lineSpaceBox.left, top: top - lineSpaceBox.top};
  }

  function charCoords(cm, pos, context, lineObj, bias) {
    if (!lineObj) lineObj = getLine(cm.doc, pos.line);
    return intoCoordSystem(cm, lineObj, measureChar(cm, lineObj, pos.ch, bias), context);
  }

  // Returns a box for a given cursor position, which may have an
  // 'other' property containing the position of the secondary cursor
  // on a bidi boundary.
  function cursorCoords(cm, pos, context, lineObj, preparedMeasure, varHeight) {
    lineObj = lineObj || getLine(cm.doc, pos.line);
    if (!preparedMeasure) preparedMeasure = prepareMeasureForLine(cm, lineObj);
    function get(ch, right) {
      var m = measureCharPrepared(cm, preparedMeasure, ch, right ? "right" : "left", varHeight);
      if (right) m.left = m.right; else m.right = m.left;
      return intoCoordSystem(cm, lineObj, m, context);
    }
    function getBidi(ch, partPos) {
      var part = order[partPos], right = part.level % 2;
      if (ch == bidiLeft(part) && partPos && part.level < order[partPos - 1].level) {
        part = order[--partPos];
        ch = bidiRight(part) - (part.level % 2 ? 0 : 1);
        right = true;
      } else if (ch == bidiRight(part) && partPos < order.length - 1 && part.level < order[partPos + 1].level) {
        part = order[++partPos];
        ch = bidiLeft(part) - part.level % 2;
        right = false;
      }
      if (right && ch == part.to && ch > part.from) return get(ch - 1);
      return get(ch, right);
    }
    var order = getOrder(lineObj), ch = pos.ch;
    if (!order) return get(ch);
    var partPos = getBidiPartAt(order, ch);
    var val = getBidi(ch, partPos);
    if (bidiOther != null) val.other = getBidi(ch, bidiOther);
    return val;
  }

  // Used to cheaply estimate the coordinates for a position. Used for
  // intermediate scroll updates.
  function estimateCoords(cm, pos) {
    var left = 0, pos = clipPos(cm.doc, pos);
    if (!cm.options.lineWrapping) left = charWidth(cm.display) * pos.ch;
    var lineObj = getLine(cm.doc, pos.line);
    var top = heightAtLine(lineObj) + paddingTop(cm.display);
    return {left: left, right: left, top: top, bottom: top + lineObj.height};
  }

  // Positions returned by coordsChar contain some extra information.
  // xRel is the relative x position of the input coordinates compared
  // to the found position (so xRel > 0 means the coordinates are to
  // the right of the character position, for example). When outside
  // is true, that means the coordinates lie outside the line's
  // vertical range.
  function PosWithInfo(line, ch, outside, xRel) {
    var pos = Pos(line, ch);
    pos.xRel = xRel;
    if (outside) pos.outside = true;
    return pos;
  }

  // Compute the character position closest to the given coordinates.
  // Input must be lineSpace-local ("div" coordinate system).
  function coordsChar(cm, x, y) {
    var doc = cm.doc;
    y += cm.display.viewOffset;
    if (y < 0) return PosWithInfo(doc.first, 0, true, -1);
    var lineN = lineAtHeight(doc, y), last = doc.first + doc.size - 1;
    if (lineN > last)
      return PosWithInfo(doc.first + doc.size - 1, getLine(doc, last).text.length, true, 1);
    if (x < 0) x = 0;

    var lineObj = getLine(doc, lineN);
    for (;;) {
      var found = coordsCharInner(cm, lineObj, lineN, x, y);
      var merged = collapsedSpanAtEnd(lineObj);
      var mergedPos = merged && merged.find(0, true);
      if (merged && (found.ch > mergedPos.from.ch || found.ch == mergedPos.from.ch && found.xRel > 0))
        lineN = lineNo(lineObj = mergedPos.to.line);
      else
        return found;
    }
  }

  function coordsCharInner(cm, lineObj, lineNo, x, y) {
    var innerOff = y - heightAtLine(lineObj);
    var wrongLine = false, adjust = 2 * cm.display.wrapper.clientWidth;
    var preparedMeasure = prepareMeasureForLine(cm, lineObj);

    function getX(ch) {
      var sp = cursorCoords(cm, Pos(lineNo, ch), "line", lineObj, preparedMeasure);
      wrongLine = true;
      if (innerOff > sp.bottom) return sp.left - adjust;
      else if (innerOff < sp.top) return sp.left + adjust;
      else wrongLine = false;
      return sp.left;
    }

    var bidi = getOrder(lineObj), dist = lineObj.text.length;
    var from = lineLeft(lineObj), to = lineRight(lineObj);
    var fromX = getX(from), fromOutside = wrongLine, toX = getX(to), toOutside = wrongLine;

    if (x > toX) return PosWithInfo(lineNo, to, toOutside, 1);
    // Do a binary search between these bounds.
    for (;;) {
      if (bidi ? to == from || to == moveVisually(lineObj, from, 1) : to - from <= 1) {
        var ch = x < fromX || x - fromX <= toX - x ? from : to;
        var xDiff = x - (ch == from ? fromX : toX);
        while (isExtendingChar(lineObj.text.charAt(ch))) ++ch;
        var pos = PosWithInfo(lineNo, ch, ch == from ? fromOutside : toOutside,
                              xDiff < -1 ? -1 : xDiff > 1 ? 1 : 0);
        return pos;
      }
      var step = Math.ceil(dist / 2), middle = from + step;
      if (bidi) {
        middle = from;
        for (var i = 0; i < step; ++i) middle = moveVisually(lineObj, middle, 1);
      }
      var middleX = getX(middle);
      if (middleX > x) {to = middle; toX = middleX; if (toOutside = wrongLine) toX += 1000; dist = step;}
      else {from = middle; fromX = middleX; fromOutside = wrongLine; dist -= step;}
    }
  }

  var measureText;
  // Compute the default text height.
  function textHeight(display) {
    if (display.cachedTextHeight != null) return display.cachedTextHeight;
    if (measureText == null) {
      measureText = elt("pre");
      // Measure a bunch of lines, for browsers that compute
      // fractional heights.
      for (var i = 0; i < 49; ++i) {
        measureText.appendChild(document.createTextNode("x"));
        measureText.appendChild(elt("br"));
      }
      measureText.appendChild(document.createTextNode("x"));
    }
    removeChildrenAndAdd(display.measure, measureText);
    var height = measureText.offsetHeight / 50;
    if (height > 3) display.cachedTextHeight = height;
    removeChildren(display.measure);
    return height || 1;
  }

  // Compute the default character width.
  function charWidth(display) {
    if (display.cachedCharWidth != null) return display.cachedCharWidth;
    var anchor = elt("span", "xxxxxxxxxx");
    var pre = elt("pre", [anchor]);
    removeChildrenAndAdd(display.measure, pre);
    var rect = anchor.getBoundingClientRect(), width = (rect.right - rect.left) / 10;
    if (width > 2) display.cachedCharWidth = width;
    return width || 10;
  }

  // OPERATIONS

  // Operations are used to wrap a series of changes to the editor
  // state in such a way that each change won't have to update the
  // cursor and display (which would be awkward, slow, and
  // error-prone). Instead, display updates are batched and then all
  // combined and executed at once.

  var operationGroup = null;

  var nextOpId = 0;
  // Start a new operation.
  function startOperation(cm) {
    cm.curOp = {
      cm: cm,
      viewChanged: false,      // Flag that indicates that lines might need to be redrawn
      startHeight: cm.doc.height, // Used to detect need to update scrollbar
      forceUpdate: false,      // Used to force a redraw
      updateInput: null,       // Whether to reset the input textarea
      typing: false,           // Whether this reset should be careful to leave existing text (for compositing)
      changeObjs: null,        // Accumulated changes, for firing change events
      cursorActivityHandlers: null, // Set of handlers to fire cursorActivity on
      cursorActivityCalled: 0, // Tracks which cursorActivity handlers have been called already
      selectionChanged: false, // Whether the selection needs to be redrawn
      updateMaxLine: false,    // Set when the widest line needs to be determined anew
      scrollLeft: null, scrollTop: null, // Intermediate scroll position, not pushed to DOM yet
      scrollToPos: null,       // Used to scroll to a specific position
      id: ++nextOpId           // Unique ID
    };
    if (operationGroup) {
      operationGroup.ops.push(cm.curOp);
    } else {
      cm.curOp.ownsGroup = operationGroup = {
        ops: [cm.curOp],
        delayedCallbacks: []
      };
    }
  }

  function fireCallbacksForOps(group) {
    // Calls delayed callbacks and cursorActivity handlers until no
    // new ones appear
    var callbacks = group.delayedCallbacks, i = 0;
    do {
      for (; i < callbacks.length; i++)
        callbacks[i]();
      for (var j = 0; j < group.ops.length; j++) {
        var op = group.ops[j];
        if (op.cursorActivityHandlers)
          while (op.cursorActivityCalled < op.cursorActivityHandlers.length)
            op.cursorActivityHandlers[op.cursorActivityCalled++](op.cm);
      }
    } while (i < callbacks.length);
  }

  // Finish an operation, updating the display and signalling delayed events
  function endOperation(cm) {
    var op = cm.curOp, group = op.ownsGroup;
    if (!group) return;

    try { fireCallbacksForOps(group); }
    finally {
      operationGroup = null;
      for (var i = 0; i < group.ops.length; i++)
        group.ops[i].cm.curOp = null;
      endOperations(group);
    }
  }

  // The DOM updates done when an operation finishes are batched so
  // that the minimum number of relayouts are required.
  function endOperations(group) {
    var ops = group.ops;
    for (var i = 0; i < ops.length; i++) // Read DOM
      endOperation_R1(ops[i]);
    for (var i = 0; i < ops.length; i++) // Write DOM (maybe)
      endOperation_W1(ops[i]);
    for (var i = 0; i < ops.length; i++) // Read DOM
      endOperation_R2(ops[i]);
    for (var i = 0; i < ops.length; i++) // Write DOM (maybe)
      endOperation_W2(ops[i]);
    for (var i = 0; i < ops.length; i++) // Read DOM
      endOperation_finish(ops[i]);
  }

  function endOperation_R1(op) {
    var cm = op.cm, display = cm.display;
    if (op.updateMaxLine) findMaxLine(cm);

    op.mustUpdate = op.viewChanged || op.forceUpdate || op.scrollTop != null ||
      op.scrollToPos && (op.scrollToPos.from.line < display.viewFrom ||
                         op.scrollToPos.to.line >= display.viewTo) ||
      display.maxLineChanged && cm.options.lineWrapping;
    op.update = op.mustUpdate &&
      new DisplayUpdate(cm, op.mustUpdate && {top: op.scrollTop, ensure: op.scrollToPos}, op.forceUpdate);
  }

  function endOperation_W1(op) {
    op.updatedDisplay = op.mustUpdate && updateDisplayIfNeeded(op.cm, op.update);
  }

  function endOperation_R2(op) {
    var cm = op.cm, display = cm.display;
    if (op.updatedDisplay) updateHeightsInViewport(cm);

    // If the max line changed since it was last measured, measure it,
    // and ensure the document's width matches it.
    // updateDisplayIfNeeded will use these properties to do the actual resizing
    if (display.maxLineChanged && !cm.options.lineWrapping) {
      op.adjustWidthTo = measureChar(cm, display.maxLine, display.maxLine.text.length).left;
      op.maxScrollLeft = Math.max(0, display.sizer.offsetLeft + op.adjustWidthTo +
                                  scrollerCutOff - display.scroller.clientWidth);
    }

    op.barMeasure = measureForScrollbars(cm);
    if (op.updatedDisplay || op.selectionChanged)
      op.newSelectionNodes = drawSelection(cm);
  }

  function endOperation_W2(op) {
    var cm = op.cm;

    if (op.adjustWidthTo != null) {
      cm.display.sizer.style.minWidth = op.adjustWidthTo + "px";
      if (op.maxScrollLeft < cm.doc.scrollLeft)
        setScrollLeft(cm, Math.min(cm.display.scroller.scrollLeft, op.maxScrollLeft), true);
    }

    if (op.newSelectionNodes)
      updateSelection(cm, op.newSelectionNodes);
    if (op.updatedDisplay)
      setDocumentHeight(cm, op.barMeasure);
    if (op.updatedDisplay || op.startHeight != cm.doc.height)
      updateScrollbars(cm, op.barMeasure);

    if (op.selectionChanged) restartBlink(cm);

    if (cm.state.focused && op.updateInput)
      resetInput(cm, op.typing);
  }

  function endOperation_finish(op) {
    var cm = op.cm, display = cm.display, doc = cm.doc;

    if (op.updatedDisplay) postUpdateDisplay(cm, op.update);

    // Abort mouse wheel delta measurement, when scrolling explicitly
    if (display.wheelStartX != null && (op.scrollTop != null || op.scrollLeft != null || op.scrollToPos))
      display.wheelStartX = display.wheelStartY = null;

    // Propagate the scroll position to the actual DOM scroller
    if (op.scrollTop != null && display.scroller.scrollTop != op.scrollTop) {
      var top = Math.max(0, Math.min(display.scroller.scrollHeight - display.scroller.clientHeight, op.scrollTop));
      display.scroller.scrollTop = display.scrollbarV.scrollTop = doc.scrollTop = top;
    }
    if (op.scrollLeft != null && display.scroller.scrollLeft != op.scrollLeft) {
      var left = Math.max(0, Math.min(display.scroller.scrollWidth - display.scroller.clientWidth, op.scrollLeft));
      display.scroller.scrollLeft = display.scrollbarH.scrollLeft = doc.scrollLeft = left;
      alignHorizontally(cm);
    }
    // If we need to scroll a specific position into view, do so.
    if (op.scrollToPos) {
      var coords = scrollPosIntoView(cm, clipPos(doc, op.scrollToPos.from),
                                     clipPos(doc, op.scrollToPos.to), op.scrollToPos.margin);
      if (op.scrollToPos.isCursor && cm.state.focused) maybeScrollWindow(cm, coords);
    }

    // Fire events for markers that are hidden/unidden by editing or
    // undoing
    var hidden = op.maybeHiddenMarkers, unhidden = op.maybeUnhiddenMarkers;
    if (hidden) for (var i = 0; i < hidden.length; ++i)
      if (!hidden[i].lines.length) signal(hidden[i], "hide");
    if (unhidden) for (var i = 0; i < unhidden.length; ++i)
      if (unhidden[i].lines.length) signal(unhidden[i], "unhide");

    if (display.wrapper.offsetHeight)
      doc.scrollTop = cm.display.scroller.scrollTop;

    // Apply workaround for two webkit bugs
    if (op.updatedDisplay && webkit) {
      if (cm.options.lineWrapping)
        checkForWebkitWidthBug(cm, op.barMeasure); // (Issue #2420)
      if (op.barMeasure.scrollWidth > op.barMeasure.clientWidth &&
          op.barMeasure.scrollWidth < op.barMeasure.clientWidth + 1 &&
          !hScrollbarTakesSpace(cm))
        updateScrollbars(cm); // (Issue #2562)
    }

    // Fire change events, and delayed event handlers
    if (op.changeObjs)
      signal(cm, "changes", cm, op.changeObjs);
  }

  // Run the given function in an operation
  function runInOp(cm, f) {
    if (cm.curOp) return f();
    startOperation(cm);
    try { return f(); }
    finally { endOperation(cm); }
  }
  // Wraps a function in an operation. Returns the wrapped function.
  function operation(cm, f) {
    return function() {
      if (cm.curOp) return f.apply(cm, arguments);
      startOperation(cm);
      try { return f.apply(cm, arguments); }
      finally { endOperation(cm); }
    };
  }
  // Used to add methods to editor and doc instances, wrapping them in
  // operations.
  function methodOp(f) {
    return function() {
      if (this.curOp) return f.apply(this, arguments);
      startOperation(this);
      try { return f.apply(this, arguments); }
      finally { endOperation(this); }
    };
  }
  function docMethodOp(f) {
    return function() {
      var cm = this.cm;
      if (!cm || cm.curOp) return f.apply(this, arguments);
      startOperation(cm);
      try { return f.apply(this, arguments); }
      finally { endOperation(cm); }
    };
  }

  // VIEW TRACKING

  // These objects are used to represent the visible (currently drawn)
  // part of the document. A LineView may correspond to multiple
  // logical lines, if those are connected by collapsed ranges.
  function LineView(doc, line, lineN) {
    // The starting line
    this.line = line;
    // Continuing lines, if any
    this.rest = visualLineContinued(line);
    // Number of logical lines in this visual line
    this.size = this.rest ? lineNo(lst(this.rest)) - lineN + 1 : 1;
    this.node = this.text = null;
    this.hidden = lineIsHidden(doc, line);
  }

  // Create a range of LineView objects for the given lines.
  function buildViewArray(cm, from, to) {
    var array = [], nextPos;
    for (var pos = from; pos < to; pos = nextPos) {
      var view = new LineView(cm.doc, getLine(cm.doc, pos), pos);
      nextPos = pos + view.size;
      array.push(view);
    }
    return array;
  }

  // Updates the display.view data structure for a given change to the
  // document. From and to are in pre-change coordinates. Lendiff is
  // the amount of lines added or subtracted by the change. This is
  // used for changes that span multiple lines, or change the way
  // lines are divided into visual lines. regLineChange (below)
  // registers single-line changes.
  function regChange(cm, from, to, lendiff) {
    if (from == null) from = cm.doc.first;
    if (to == null) to = cm.doc.first + cm.doc.size;
    if (!lendiff) lendiff = 0;

    var display = cm.display;
    if (lendiff && to < display.viewTo &&
        (display.updateLineNumbers == null || display.updateLineNumbers > from))
      display.updateLineNumbers = from;

    cm.curOp.viewChanged = true;

    if (from >= display.viewTo) { // Change after
      if (sawCollapsedSpans && visualLineNo(cm.doc, from) < display.viewTo)
        resetView(cm);
    } else if (to <= display.viewFrom) { // Change before
      if (sawCollapsedSpans && visualLineEndNo(cm.doc, to + lendiff) > display.viewFrom) {
        resetView(cm);
      } else {
        display.viewFrom += lendiff;
        display.viewTo += lendiff;
      }
    } else if (from <= display.viewFrom && to >= display.viewTo) { // Full overlap
      resetView(cm);
    } else if (from <= display.viewFrom) { // Top overlap
      var cut = viewCuttingPoint(cm, to, to + lendiff, 1);
      if (cut) {
        display.view = display.view.slice(cut.index);
        display.viewFrom = cut.lineN;
        display.viewTo += lendiff;
      } else {
        resetView(cm);
      }
    } else if (to >= display.viewTo) { // Bottom overlap
      var cut = viewCuttingPoint(cm, from, from, -1);
      if (cut) {
        display.view = display.view.slice(0, cut.index);
        display.viewTo = cut.lineN;
      } else {
        resetView(cm);
      }
    } else { // Gap in the middle
      var cutTop = viewCuttingPoint(cm, from, from, -1);
      var cutBot = viewCuttingPoint(cm, to, to + lendiff, 1);
      if (cutTop && cutBot) {
        display.view = display.view.slice(0, cutTop.index)
          .concat(buildViewArray(cm, cutTop.lineN, cutBot.lineN))
          .concat(display.view.slice(cutBot.index));
        display.viewTo += lendiff;
      } else {
        resetView(cm);
      }
    }

    var ext = display.externalMeasured;
    if (ext) {
      if (to < ext.lineN)
        ext.lineN += lendiff;
      else if (from < ext.lineN + ext.size)
        display.externalMeasured = null;
    }
  }

  // Register a change to a single line. Type must be one of "text",
  // "gutter", "class", "widget"
  function regLineChange(cm, line, type) {
    cm.curOp.viewChanged = true;
    var display = cm.display, ext = cm.display.externalMeasured;
    if (ext && line >= ext.lineN && line < ext.lineN + ext.size)
      display.externalMeasured = null;

    if (line < display.viewFrom || line >= display.viewTo) return;
    var lineView = display.view[findViewIndex(cm, line)];
    if (lineView.node == null) return;
    var arr = lineView.changes || (lineView.changes = []);
    if (indexOf(arr, type) == -1) arr.push(type);
  }

  // Clear the view.
  function resetView(cm) {
    cm.display.viewFrom = cm.display.viewTo = cm.doc.first;
    cm.display.view = [];
    cm.display.viewOffset = 0;
  }

  // Find the view element corresponding to a given line. Return null
  // when the line isn't visible.
  function findViewIndex(cm, n) {
    if (n >= cm.display.viewTo) return null;
    n -= cm.display.viewFrom;
    if (n < 0) return null;
    var view = cm.display.view;
    for (var i = 0; i < view.length; i++) {
      n -= view[i].size;
      if (n < 0) return i;
    }
  }

  function viewCuttingPoint(cm, oldN, newN, dir) {
    var index = findViewIndex(cm, oldN), diff, view = cm.display.view;
    if (!sawCollapsedSpans || newN == cm.doc.first + cm.doc.size)
      return {index: index, lineN: newN};
    for (var i = 0, n = cm.display.viewFrom; i < index; i++)
      n += view[i].size;
    if (n != oldN) {
      if (dir > 0) {
        if (index == view.length - 1) return null;
        diff = (n + view[index].size) - oldN;
        index++;
      } else {
        diff = n - oldN;
      }
      oldN += diff; newN += diff;
    }
    while (visualLineNo(cm.doc, newN) != newN) {
      if (index == (dir < 0 ? 0 : view.length - 1)) return null;
      newN += dir * view[index - (dir < 0 ? 1 : 0)].size;
      index += dir;
    }
    return {index: index, lineN: newN};
  }

  // Force the view to cover a given range, adding empty view element
  // or clipping off existing ones as needed.
  function adjustView(cm, from, to) {
    var display = cm.display, view = display.view;
    if (view.length == 0 || from >= display.viewTo || to <= display.viewFrom) {
      display.view = buildViewArray(cm, from, to);
      display.viewFrom = from;
    } else {
      if (display.viewFrom > from)
        display.view = buildViewArray(cm, from, display.viewFrom).concat(display.view);
      else if (display.viewFrom < from)
        display.view = display.view.slice(findViewIndex(cm, from));
      display.viewFrom = from;
      if (display.viewTo < to)
        display.view = display.view.concat(buildViewArray(cm, display.viewTo, to));
      else if (display.viewTo > to)
        display.view = display.view.slice(0, findViewIndex(cm, to));
    }
    display.viewTo = to;
  }

  // Count the number of lines in the view whose DOM representation is
  // out of date (or nonexistent).
  function countDirtyView(cm) {
    var view = cm.display.view, dirty = 0;
    for (var i = 0; i < view.length; i++) {
      var lineView = view[i];
      if (!lineView.hidden && (!lineView.node || lineView.changes)) ++dirty;
    }
    return dirty;
  }

  // INPUT HANDLING

  // Poll for input changes, using the normal rate of polling. This
  // runs as long as the editor is focused.
  function slowPoll(cm) {
    if (cm.display.pollingFast) return;
    cm.display.poll.set(cm.options.pollInterval, function() {
      readInput(cm);
      if (cm.state.focused) slowPoll(cm);
    });
  }

  // When an event has just come in that is likely to add or change
  // something in the input textarea, we poll faster, to ensure that
  // the change appears on the screen quickly.
  function fastPoll(cm) {
    var missed = false;
    cm.display.pollingFast = true;
    function p() {
      var changed = readInput(cm);
      if (!changed && !missed) {missed = true; cm.display.poll.set(60, p);}
      else {cm.display.pollingFast = false; slowPoll(cm);}
    }
    cm.display.poll.set(20, p);
  }

  // This will be set to an array of strings when copying, so that,
  // when pasting, we know what kind of selections the copied text
  // was made out of.
  var lastCopied = null;

  // Read input from the textarea, and update the document to match.
  // When something is selected, it is present in the textarea, and
  // selected (unless it is huge, in which case a placeholder is
  // used). When nothing is selected, the cursor sits after previously
  // seen text (can be empty), which is stored in prevInput (we must
  // not reset the textarea when typing, because that breaks IME).
  function readInput(cm) {
    var input = cm.display.input, prevInput = cm.display.prevInput, doc = cm.doc;
    // Since this is called a *lot*, try to bail out as cheaply as
    // possible when it is clear that nothing happened. hasSelection
    // will be the case when there is a lot of text in the textarea,
    // in which case reading its value would be expensive.
    if (!cm.state.focused || (hasSelection(input) && !prevInput) || isReadOnly(cm) || cm.options.disableInput)
      return false;
    // See paste handler for more on the fakedLastChar kludge
    if (cm.state.pasteIncoming && cm.state.fakedLastChar) {
      input.value = input.value.substring(0, input.value.length - 1);
      cm.state.fakedLastChar = false;
    }
    var text = input.value;
    // If nothing changed, bail.
    if (text == prevInput && !cm.somethingSelected()) return false;
    // Work around nonsensical selection resetting in IE9/10, and
    // inexplicable appearance of private area unicode characters on
    // some key combos in Mac (#2689).
    if (ie && ie_version >= 9 && cm.display.inputHasSelection === text ||
        mac && /[\uf700-\uf7ff]/.test(text)) {
      resetInput(cm);
      return false;
    }

    var withOp = !cm.curOp;
    if (withOp) startOperation(cm);
    cm.display.shift = false;

    if (text.charCodeAt(0) == 0x200b && doc.sel == cm.display.selForContextMenu && !prevInput)
      prevInput = "\u200b";
    // Find the part of the input that is actually new
    var same = 0, l = Math.min(prevInput.length, text.length);
    while (same < l && prevInput.charCodeAt(same) == text.charCodeAt(same)) ++same;
    var inserted = text.slice(same), textLines = splitLines(inserted);

    // When pasing N lines into N selections, insert one line per selection
    var multiPaste = null;
    if (cm.state.pasteIncoming && doc.sel.ranges.length > 1) {
      if (lastCopied && lastCopied.join("\n") == inserted)
        multiPaste = doc.sel.ranges.length % lastCopied.length == 0 && map(lastCopied, splitLines);
      else if (textLines.length == doc.sel.ranges.length)
        multiPaste = map(textLines, function(l) { return [l]; });
    }

    // Normal behavior is to insert the new text into every selection
    for (var i = doc.sel.ranges.length - 1; i >= 0; i--) {
      var range = doc.sel.ranges[i];
      var from = range.from(), to = range.to();
      // Handle deletion
      if (same < prevInput.length)
        from = Pos(from.line, from.ch - (prevInput.length - same));
      // Handle overwrite
      else if (cm.state.overwrite && range.empty() && !cm.state.pasteIncoming)
        to = Pos(to.line, Math.min(getLine(doc, to.line).text.length, to.ch + lst(textLines).length));
      var updateInput = cm.curOp.updateInput;
      var changeEvent = {from: from, to: to, text: multiPaste ? multiPaste[i % multiPaste.length] : textLines,
                         origin: cm.state.pasteIncoming ? "paste" : cm.state.cutIncoming ? "cut" : "+input"};
      makeChange(cm.doc, changeEvent);
      signalLater(cm, "inputRead", cm, changeEvent);
      // When an 'electric' character is inserted, immediately trigger a reindent
      if (inserted && !cm.state.pasteIncoming && cm.options.electricChars &&
          cm.options.smartIndent && range.head.ch < 100 &&
          (!i || doc.sel.ranges[i - 1].head.line != range.head.line)) {
        var mode = cm.getModeAt(range.head);
        if (mode.electricChars) {
          for (var j = 0; j < mode.electricChars.length; j++)
            if (inserted.indexOf(mode.electricChars.charAt(j)) > -1) {
              indentLine(cm, range.head.line, "smart");
              break;
            }
        } else if (mode.electricInput) {
          var end = changeEnd(changeEvent);
          if (mode.electricInput.test(getLine(doc, end.line).text.slice(0, end.ch)))
            indentLine(cm, range.head.line, "smart");
        }
      }
    }
    ensureCursorVisible(cm);
    cm.curOp.updateInput = updateInput;
    cm.curOp.typing = true;

    // Don't leave long text in the textarea, since it makes further polling slow
    if (text.length > 1000 || text.indexOf("\n") > -1) input.value = cm.display.prevInput = "";
    else cm.display.prevInput = text;
    if (withOp) endOperation(cm);
    cm.state.pasteIncoming = cm.state.cutIncoming = false;
    return true;
  }

  // Reset the input to correspond to the selection (or to be empty,
  // when not typing and nothing is selected)
  function resetInput(cm, typing) {
    var minimal, selected, doc = cm.doc;
    if (cm.somethingSelected()) {
      cm.display.prevInput = "";
      var range = doc.sel.primary();
      minimal = hasCopyEvent &&
        (range.to().line - range.from().line > 100 || (selected = cm.getSelection()).length > 1000);
      var content = minimal ? "-" : selected || cm.getSelection();
      cm.display.input.value = content;
      if (cm.state.focused) selectInput(cm.display.input);
      if (ie && ie_version >= 9) cm.display.inputHasSelection = content;
    } else if (!typing) {
      cm.display.prevInput = cm.display.input.value = "";
      if (ie && ie_version >= 9) cm.display.inputHasSelection = null;
    }
    cm.display.inaccurateSelection = minimal;
  }

  function focusInput(cm) {
    if (cm.options.readOnly != "nocursor" && (!mobile || activeElt() != cm.display.input))
      cm.display.input.focus();
  }

  function ensureFocus(cm) {
    if (!cm.state.focused) { focusInput(cm); onFocus(cm); }
  }

  function isReadOnly(cm) {
    return cm.options.readOnly || cm.doc.cantEdit;
  }

  // EVENT HANDLERS

  // Attach the necessary event handlers when initializing the editor
  function registerEventHandlers(cm) {
    var d = cm.display;
    on(d.scroller, "mousedown", operation(cm, onMouseDown));
    // Older IE's will not fire a second mousedown for a double click
    if (ie && ie_version < 11)
      on(d.scroller, "dblclick", operation(cm, function(e) {
        if (signalDOMEvent(cm, e)) return;
        var pos = posFromMouse(cm, e);
        if (!pos || clickInGutter(cm, e) || eventInWidget(cm.display, e)) return;
        e_preventDefault(e);
        var word = findWordAt(cm, pos);
        extendSelection(cm.doc, word.anchor, word.head);
      }));
    else
      on(d.scroller, "dblclick", function(e) { signalDOMEvent(cm, e) || e_preventDefault(e); });
    // Prevent normal selection in the editor (we handle our own)
    on(d.lineSpace, "selectstart", function(e) {
      if (!eventInWidget(d, e)) e_preventDefault(e);
    });
    // Some browsers fire contextmenu *after* opening the menu, at
    // which point we can't mess with it anymore. Context menu is
    // handled in onMouseDown for these browsers.
    if (!captureRightClick) on(d.scroller, "contextmenu", function(e) {onContextMenu(cm, e);});

    // Sync scrolling between fake scrollbars and real scrollable
    // area, ensure viewport is updated when scrolling.
    on(d.scroller, "scroll", function() {
      if (d.scroller.clientHeight) {
        setScrollTop(cm, d.scroller.scrollTop);
        setScrollLeft(cm, d.scroller.scrollLeft, true);
        signal(cm, "scroll", cm);
      }
    });
    on(d.scrollbarV, "scroll", function() {
      if (d.scroller.clientHeight) setScrollTop(cm, d.scrollbarV.scrollTop);
    });
    on(d.scrollbarH, "scroll", function() {
      if (d.scroller.clientHeight) setScrollLeft(cm, d.scrollbarH.scrollLeft);
    });

    // Listen to wheel events in order to try and update the viewport on time.
    on(d.scroller, "mousewheel", function(e){onScrollWheel(cm, e);});
    on(d.scroller, "DOMMouseScroll", function(e){onScrollWheel(cm, e);});

    // Prevent clicks in the scrollbars from killing focus
    function reFocus() { if (cm.state.focused) setTimeout(bind(focusInput, cm), 0); }
    on(d.scrollbarH, "mousedown", reFocus);
    on(d.scrollbarV, "mousedown", reFocus);
    // Prevent wrapper from ever scrolling
    on(d.wrapper, "scroll", function() { d.wrapper.scrollTop = d.wrapper.scrollLeft = 0; });

    on(d.input, "keyup", function(e) { onKeyUp.call(cm, e); });
    on(d.input, "input", function() {
      if (ie && ie_version >= 9 && cm.display.inputHasSelection) cm.display.inputHasSelection = null;
      fastPoll(cm);
    });
    on(d.input, "keydown", operation(cm, onKeyDown));
    on(d.input, "keypress", operation(cm, onKeyPress));
    on(d.input, "focus", bind(onFocus, cm));
    on(d.input, "blur", bind(onBlur, cm));

    function drag_(e) {
      if (!signalDOMEvent(cm, e)) e_stop(e);
    }
    if (cm.options.dragDrop) {
      on(d.scroller, "dragstart", function(e){onDragStart(cm, e);});
      on(d.scroller, "dragenter", drag_);
      on(d.scroller, "dragover", drag_);
      on(d.scroller, "drop", operation(cm, onDrop));
    }
    on(d.scroller, "paste", function(e) {
      if (eventInWidget(d, e)) return;
      cm.state.pasteIncoming = true;
      focusInput(cm);
      fastPoll(cm);
    });
    on(d.input, "paste", function() {
      // Workaround for webkit bug https://bugs.webkit.org/show_bug.cgi?id=90206
      // Add a char to the end of textarea before paste occur so that
      // selection doesn't span to the end of textarea.
      if (webkit && !cm.state.fakedLastChar && !(new Date - cm.state.lastMiddleDown < 200)) {
        var start = d.input.selectionStart, end = d.input.selectionEnd;
        d.input.value += "$";
        // The selection end needs to be set before the start, otherwise there
        // can be an intermediate non-empty selection between the two, which
        // can override the middle-click paste buffer on linux and cause the
        // wrong thing to get pasted.
        d.input.selectionEnd = end;
        d.input.selectionStart = start;
        cm.state.fakedLastChar = true;
      }
      cm.state.pasteIncoming = true;
      fastPoll(cm);
    });

    function prepareCopyCut(e) {
      if (cm.somethingSelected()) {
        lastCopied = cm.getSelections();
        if (d.inaccurateSelection) {
          d.prevInput = "";
          d.inaccurateSelection = false;
          d.input.value = lastCopied.join("\n");
          selectInput(d.input);
        }
      } else {
        var text = [], ranges = [];
        for (var i = 0; i < cm.doc.sel.ranges.length; i++) {
          var line = cm.doc.sel.ranges[i].head.line;
          var lineRange = {anchor: Pos(line, 0), head: Pos(line + 1, 0)};
          ranges.push(lineRange);
          text.push(cm.getRange(lineRange.anchor, lineRange.head));
        }
        if (e.type == "cut") {
          cm.setSelections(ranges, null, sel_dontScroll);
        } else {
          d.prevInput = "";
          d.input.value = text.join("\n");
          selectInput(d.input);
        }
        lastCopied = text;
      }
      if (e.type == "cut") cm.state.cutIncoming = true;
    }
    on(d.input, "cut", prepareCopyCut);
    on(d.input, "copy", prepareCopyCut);

    // Needed to handle Tab key in KHTML
    if (khtml) on(d.sizer, "mouseup", function() {
      if (activeElt() == d.input) d.input.blur();
      focusInput(cm);
    });
  }

  // Called when the window resizes
  function onResize(cm) {
    // Might be a text scaling operation, clear size caches.
    var d = cm.display;
    d.cachedCharWidth = d.cachedTextHeight = d.cachedPaddingH = null;
    cm.setSize();
  }

  // MOUSE EVENTS

  // Return true when the given mouse event happened in a widget
  function eventInWidget(display, e) {
    for (var n = e_target(e); n != display.wrapper; n = n.parentNode) {
      if (!n || n.ignoreEvents || n.parentNode == display.sizer && n != display.mover) return true;
    }
  }

  // Given a mouse event, find the corresponding position. If liberal
  // is false, it checks whether a gutter or scrollbar was clicked,
  // and returns null if it was. forRect is used by rectangular
  // selections, and tries to estimate a character position even for
  // coordinates beyond the right of the text.
  function posFromMouse(cm, e, liberal, forRect) {
    var display = cm.display;
    if (!liberal) {
      var target = e_target(e);
      if (target == display.scrollbarH || target == display.scrollbarV ||
          target == display.scrollbarFiller || target == display.gutterFiller) return null;
    }
    var x, y, space = display.lineSpace.getBoundingClientRect();
    // Fails unpredictably on IE[67] when mouse is dragged around quickly.
    try { x = e.clientX - space.left; y = e.clientY - space.top; }
    catch (e) { return null; }
    var coords = coordsChar(cm, x, y), line;
    if (forRect && coords.xRel == 1 && (line = getLine(cm.doc, coords.line).text).length == coords.ch) {
      var colDiff = countColumn(line, line.length, cm.options.tabSize) - line.length;
      coords = Pos(coords.line, Math.max(0, Math.round((x - paddingH(cm.display).left) / charWidth(cm.display)) - colDiff));
    }
    return coords;
  }

  // A mouse down can be a single click, double click, triple click,
  // start of selection drag, start of text drag, new cursor
  // (ctrl-click), rectangle drag (alt-drag), or xwin
  // middle-click-paste. Or it might be a click on something we should
  // not interfere with, such as a scrollbar or widget.
  function onMouseDown(e) {
    if (signalDOMEvent(this, e)) return;
    var cm = this, display = cm.display;
    display.shift = e.shiftKey;

    if (eventInWidget(display, e)) {
      if (!webkit) {
        // Briefly turn off draggability, to allow widgets to do
        // normal dragging things.
        display.scroller.draggable = false;
        setTimeout(function(){display.scroller.draggable = true;}, 100);
      }
      return;
    }
    if (clickInGutter(cm, e)) return;
    var start = posFromMouse(cm, e);
    window.focus();

    switch (e_button(e)) {
    case 1:
      if (start)
        leftButtonDown(cm, e, start);
      else if (e_target(e) == display.scroller)
        e_preventDefault(e);
      break;
    case 2:
      if (webkit) cm.state.lastMiddleDown = +new Date;
      if (start) extendSelection(cm.doc, start);
      setTimeout(bind(focusInput, cm), 20);
      e_preventDefault(e);
      break;
    case 3:
      if (captureRightClick) onContextMenu(cm, e);
      break;
    }
  }

  var lastClick, lastDoubleClick;
  function leftButtonDown(cm, e, start) {
    setTimeout(bind(ensureFocus, cm), 0);

    var now = +new Date, type;
    if (lastDoubleClick && lastDoubleClick.time > now - 400 && cmp(lastDoubleClick.pos, start) == 0) {
      type = "triple";
    } else if (lastClick && lastClick.time > now - 400 && cmp(lastClick.pos, start) == 0) {
      type = "double";
      lastDoubleClick = {time: now, pos: start};
    } else {
      type = "single";
      lastClick = {time: now, pos: start};
    }

    var sel = cm.doc.sel, modifier = mac ? e.metaKey : e.ctrlKey;
    if (cm.options.dragDrop && dragAndDrop && !isReadOnly(cm) &&
        type == "single" && sel.contains(start) > -1 && sel.somethingSelected())
      leftButtonStartDrag(cm, e, start, modifier);
    else
      leftButtonSelect(cm, e, start, type, modifier);
  }

  // Start a text drag. When it ends, see if any dragging actually
  // happen, and treat as a click if it didn't.
  function leftButtonStartDrag(cm, e, start, modifier) {
    var display = cm.display;
    var dragEnd = operation(cm, function(e2) {
      if (webkit) display.scroller.draggable = false;
      cm.state.draggingText = false;
      off(document, "mouseup", dragEnd);
      off(display.scroller, "drop", dragEnd);
      if (Math.abs(e.clientX - e2.clientX) + Math.abs(e.clientY - e2.clientY) < 10) {
        e_preventDefault(e2);
        if (!modifier)
          extendSelection(cm.doc, start);
        focusInput(cm);
        // Work around unexplainable focus problem in IE9 (#2127)
        if (ie && ie_version == 9)
          setTimeout(function() {document.body.focus(); focusInput(cm);}, 20);
      }
    });
    // Let the drag handler handle this.
    if (webkit) display.scroller.draggable = true;
    cm.state.draggingText = dragEnd;
    // IE's approach to draggable
    if (display.scroller.dragDrop) display.scroller.dragDrop();
    on(document, "mouseup", dragEnd);
    on(display.scroller, "drop", dragEnd);
  }

  // Normal selection, as opposed to text dragging.
  function leftButtonSelect(cm, e, start, type, addNew) {
    var display = cm.display, doc = cm.doc;
    e_preventDefault(e);

    var ourRange, ourIndex, startSel = doc.sel;
    if (addNew && !e.shiftKey) {
      ourIndex = doc.sel.contains(start);
      if (ourIndex > -1)
        ourRange = doc.sel.ranges[ourIndex];
      else
        ourRange = new Range(start, start);
    } else {
      ourRange = doc.sel.primary();
    }

    if (e.altKey) {
      type = "rect";
      if (!addNew) ourRange = new Range(start, start);
      start = posFromMouse(cm, e, true, true);
      ourIndex = -1;
    } else if (type == "double") {
      var word = findWordAt(cm, start);
      if (cm.display.shift || doc.extend)
        ourRange = extendRange(doc, ourRange, word.anchor, word.head);
      else
        ourRange = word;
    } else if (type == "triple") {
      var line = new Range(Pos(start.line, 0), clipPos(doc, Pos(start.line + 1, 0)));
      if (cm.display.shift || doc.extend)
        ourRange = extendRange(doc, ourRange, line.anchor, line.head);
      else
        ourRange = line;
    } else {
      ourRange = extendRange(doc, ourRange, start);
    }

    if (!addNew) {
      ourIndex = 0;
      setSelection(doc, new Selection([ourRange], 0), sel_mouse);
      startSel = doc.sel;
    } else if (ourIndex > -1) {
      replaceOneSelection(doc, ourIndex, ourRange, sel_mouse);
    } else {
      ourIndex = doc.sel.ranges.length;
      setSelection(doc, normalizeSelection(doc.sel.ranges.concat([ourRange]), ourIndex),
                   {scroll: false, origin: "*mouse"});
    }

    var lastPos = start;
    function extendTo(pos) {
      if (cmp(lastPos, pos) == 0) return;
      lastPos = pos;

      if (type == "rect") {
        var ranges = [], tabSize = cm.options.tabSize;
        var startCol = countColumn(getLine(doc, start.line).text, start.ch, tabSize);
        var posCol = countColumn(getLine(doc, pos.line).text, pos.ch, tabSize);
        var left = Math.min(startCol, posCol), right = Math.max(startCol, posCol);
        for (var line = Math.min(start.line, pos.line), end = Math.min(cm.lastLine(), Math.max(start.line, pos.line));
             line <= end; line++) {
          var text = getLine(doc, line).text, leftPos = findColumn(text, left, tabSize);
          if (left == right)
            ranges.push(new Range(Pos(line, leftPos), Pos(line, leftPos)));
          else if (text.length > leftPos)
            ranges.push(new Range(Pos(line, leftPos), Pos(line, findColumn(text, right, tabSize))));
        }
        if (!ranges.length) ranges.push(new Range(start, start));
        setSelection(doc, normalizeSelection(startSel.ranges.slice(0, ourIndex).concat(ranges), ourIndex),
                     {origin: "*mouse", scroll: false});
        cm.scrollIntoView(pos);
      } else {
        var oldRange = ourRange;
        var anchor = oldRange.anchor, head = pos;
        if (type != "single") {
          if (type == "double")
            var range = findWordAt(cm, pos);
          else
            var range = new Range(Pos(pos.line, 0), clipPos(doc, Pos(pos.line + 1, 0)));
          if (cmp(range.anchor, anchor) > 0) {
            head = range.head;
            anchor = minPos(oldRange.from(), range.anchor);
          } else {
            head = range.anchor;
            anchor = maxPos(oldRange.to(), range.head);
          }
        }
        var ranges = startSel.ranges.slice(0);
        ranges[ourIndex] = new Range(clipPos(doc, anchor), head);
        setSelection(doc, normalizeSelection(ranges, ourIndex), sel_mouse);
      }
    }

    var editorSize = display.wrapper.getBoundingClientRect();
    // Used to ensure timeout re-tries don't fire when another extend
    // happened in the meantime (clearTimeout isn't reliable -- at
    // least on Chrome, the timeouts still happen even when cleared,
    // if the clear happens after their scheduled firing time).
    var counter = 0;

    function extend(e) {
      var curCount = ++counter;
      var cur = posFromMouse(cm, e, true, type == "rect");
      if (!cur) return;
      if (cmp(cur, lastPos) != 0) {
        ensureFocus(cm);
        extendTo(cur);
        var visible = visibleLines(display, doc);
        if (cur.line >= visible.to || cur.line < visible.from)
          setTimeout(operation(cm, function(){if (counter == curCount) extend(e);}), 150);
      } else {
        var outside = e.clientY < editorSize.top ? -20 : e.clientY > editorSize.bottom ? 20 : 0;
        if (outside) setTimeout(operation(cm, function() {
          if (counter != curCount) return;
          display.scroller.scrollTop += outside;
          extend(e);
        }), 50);
      }
    }

    function done(e) {
      counter = Infinity;
      e_preventDefault(e);
      focusInput(cm);
      off(document, "mousemove", move);
      off(document, "mouseup", up);
      doc.history.lastSelOrigin = null;
    }

    var move = operation(cm, function(e) {
      if (!e_button(e)) done(e);
      else extend(e);
    });
    var up = operation(cm, done);
    on(document, "mousemove", move);
    on(document, "mouseup", up);
  }

  // Determines whether an event happened in the gutter, and fires the
  // handlers for the corresponding event.
  function gutterEvent(cm, e, type, prevent, signalfn) {
    try { var mX = e.clientX, mY = e.clientY; }
    catch(e) { return false; }
    if (mX >= Math.floor(cm.display.gutters.getBoundingClientRect().right)) return false;
    if (prevent) e_preventDefault(e);

    var display = cm.display;
    var lineBox = display.lineDiv.getBoundingClientRect();

    if (mY > lineBox.bottom || !hasHandler(cm, type)) return e_defaultPrevented(e);
    mY -= lineBox.top - display.viewOffset;

    for (var i = 0; i < cm.options.gutters.length; ++i) {
      var g = display.gutters.childNodes[i];
      if (g && g.getBoundingClientRect().right >= mX) {
        var line = lineAtHeight(cm.doc, mY);
        var gutter = cm.options.gutters[i];
        signalfn(cm, type, cm, line, gutter, e);
        return e_defaultPrevented(e);
      }
    }
  }

  function clickInGutter(cm, e) {
    return gutterEvent(cm, e, "gutterClick", true, signalLater);
  }

  // Kludge to work around strange IE behavior where it'll sometimes
  // re-fire a series of drag-related events right after the drop (#1551)
  var lastDrop = 0;

  function onDrop(e) {
    var cm = this;
    if (signalDOMEvent(cm, e) || eventInWidget(cm.display, e))
      return;
    e_preventDefault(e);
    if (ie) lastDrop = +new Date;
    var pos = posFromMouse(cm, e, true), files = e.dataTransfer.files;
    if (!pos || isReadOnly(cm)) return;
    // Might be a file drop, in which case we simply extract the text
    // and insert it.
    if (files && files.length && window.FileReader && window.File) {
      var n = files.length, text = Array(n), read = 0;
      var loadFile = function(file, i) {
        var reader = new FileReader;
        reader.onload = operation(cm, function() {
          text[i] = reader.result;
          if (++read == n) {
            pos = clipPos(cm.doc, pos);
            var change = {from: pos, to: pos, text: splitLines(text.join("\n")), origin: "paste"};
            makeChange(cm.doc, change);
            setSelectionReplaceHistory(cm.doc, simpleSelection(pos, changeEnd(change)));
          }
        });
        reader.readAsText(file);
      };
      for (var i = 0; i < n; ++i) loadFile(files[i], i);
    } else { // Normal drop
      // Don't do a replace if the drop happened inside of the selected text.
      if (cm.state.draggingText && cm.doc.sel.contains(pos) > -1) {
        cm.state.draggingText(e);
        // Ensure the editor is re-focused
        setTimeout(bind(focusInput, cm), 20);
        return;
      }
      try {
        var text = e.dataTransfer.getData("Text");
        if (text) {
          if (cm.state.draggingText && !(mac ? e.metaKey : e.ctrlKey))
            var selected = cm.listSelections();
          setSelectionNoUndo(cm.doc, simpleSelection(pos, pos));
          if (selected) for (var i = 0; i < selected.length; ++i)
            replaceRange(cm.doc, "", selected[i].anchor, selected[i].head, "drag");
          cm.replaceSelection(text, "around", "paste");
          focusInput(cm);
        }
      }
      catch(e){}
    }
  }

  function onDragStart(cm, e) {
    if (ie && (!cm.state.draggingText || +new Date - lastDrop < 100)) { e_stop(e); return; }
    if (signalDOMEvent(cm, e) || eventInWidget(cm.display, e)) return;

    e.dataTransfer.setData("Text", cm.getSelection());

    // Use dummy image instead of default browsers image.
    // Recent Safari (~6.0.2) have a tendency to segfault when this happens, so we don't do it there.
    if (e.dataTransfer.setDragImage && !safari) {
      var img = elt("img", null, null, "position: fixed; left: 0; top: 0;");
      img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
      if (presto) {
        img.width = img.height = 1;
        cm.display.wrapper.appendChild(img);
        // Force a relayout, or Opera won't use our image for some obscure reason
        img._top = img.offsetTop;
      }
      e.dataTransfer.setDragImage(img, 0, 0);
      if (presto) img.parentNode.removeChild(img);
    }
  }

  // SCROLL EVENTS

  // Sync the scrollable area and scrollbars, ensure the viewport
  // covers the visible area.
  function setScrollTop(cm, val) {
    if (Math.abs(cm.doc.scrollTop - val) < 2) return;
    cm.doc.scrollTop = val;
    if (!gecko) updateDisplaySimple(cm, {top: val});
    if (cm.display.scroller.scrollTop != val) cm.display.scroller.scrollTop = val;
    if (cm.display.scrollbarV.scrollTop != val) cm.display.scrollbarV.scrollTop = val;
    if (gecko) updateDisplaySimple(cm);
    startWorker(cm, 100);
  }
  // Sync scroller and scrollbar, ensure the gutter elements are
  // aligned.
  function setScrollLeft(cm, val, isScroller) {
    if (isScroller ? val == cm.doc.scrollLeft : Math.abs(cm.doc.scrollLeft - val) < 2) return;
    val = Math.min(val, cm.display.scroller.scrollWidth - cm.display.scroller.clientWidth);
    cm.doc.scrollLeft = val;
    alignHorizontally(cm);
    if (cm.display.scroller.scrollLeft != val) cm.display.scroller.scrollLeft = val;
    if (cm.display.scrollbarH.scrollLeft != val) cm.display.scrollbarH.scrollLeft = val;
  }

  // Since the delta values reported on mouse wheel events are
  // unstandardized between browsers and even browser versions, and
  // generally horribly unpredictable, this code starts by measuring
  // the scroll effect that the first few mouse wheel events have,
  // and, from that, detects the way it can convert deltas to pixel
  // offsets afterwards.
  //
  // The reason we want to know the amount a wheel event will scroll
  // is that it gives us a chance to update the display before the
  // actual scrolling happens, reducing flickering.

  var wheelSamples = 0, wheelPixelsPerUnit = null;
  // Fill in a browser-detected starting value on browsers where we
  // know one. These don't have to be accurate -- the result of them
  // being wrong would just be a slight flicker on the first wheel
  // scroll (if it is large enough).
  if (ie) wheelPixelsPerUnit = -.53;
  else if (gecko) wheelPixelsPerUnit = 15;
  else if (chrome) wheelPixelsPerUnit = -.7;
  else if (safari) wheelPixelsPerUnit = -1/3;

  function onScrollWheel(cm, e) {
    var dx = e.wheelDeltaX, dy = e.wheelDeltaY;
    if (dx == null && e.detail && e.axis == e.HORIZONTAL_AXIS) dx = e.detail;
    if (dy == null && e.detail && e.axis == e.VERTICAL_AXIS) dy = e.detail;
    else if (dy == null) dy = e.wheelDelta;

    var display = cm.display, scroll = display.scroller;
    // Quit if there's nothing to scroll here
    if (!(dx && scroll.scrollWidth > scroll.clientWidth ||
          dy && scroll.scrollHeight > scroll.clientHeight)) return;

    // Webkit browsers on OS X abort momentum scrolls when the target
    // of the scroll event is removed from the scrollable element.
    // This hack (see related code in patchDisplay) makes sure the
    // element is kept around.
    if (dy && mac && webkit) {
      outer: for (var cur = e.target, view = display.view; cur != scroll; cur = cur.parentNode) {
        for (var i = 0; i < view.length; i++) {
          if (view[i].node == cur) {
            cm.display.currentWheelTarget = cur;
            break outer;
          }
        }
      }
    }

    // On some browsers, horizontal scrolling will cause redraws to
    // happen before the gutter has been realigned, causing it to
    // wriggle around in a most unseemly way. When we have an
    // estimated pixels/delta value, we just handle horizontal
    // scrolling entirely here. It'll be slightly off from native, but
    // better than glitching out.
    if (dx && !gecko && !presto && wheelPixelsPerUnit != null) {
      if (dy)
        setScrollTop(cm, Math.max(0, Math.min(scroll.scrollTop + dy * wheelPixelsPerUnit, scroll.scrollHeight - scroll.clientHeight)));
      setScrollLeft(cm, Math.max(0, Math.min(scroll.scrollLeft + dx * wheelPixelsPerUnit, scroll.scrollWidth - scroll.clientWidth)));
      e_preventDefault(e);
      display.wheelStartX = null; // Abort measurement, if in progress
      return;
    }

    // 'Project' the visible viewport to cover the area that is being
    // scrolled into view (if we know enough to estimate it).
    if (dy && wheelPixelsPerUnit != null) {
      var pixels = dy * wheelPixelsPerUnit;
      var top = cm.doc.scrollTop, bot = top + display.wrapper.clientHeight;
      if (pixels < 0) top = Math.max(0, top + pixels - 50);
      else bot = Math.min(cm.doc.height, bot + pixels + 50);
      updateDisplaySimple(cm, {top: top, bottom: bot});
    }

    if (wheelSamples < 20) {
      if (display.wheelStartX == null) {
        display.wheelStartX = scroll.scrollLeft; display.wheelStartY = scroll.scrollTop;
        display.wheelDX = dx; display.wheelDY = dy;
        setTimeout(function() {
          if (display.wheelStartX == null) return;
          var movedX = scroll.scrollLeft - display.wheelStartX;
          var movedY = scroll.scrollTop - display.wheelStartY;
          var sample = (movedY && display.wheelDY && movedY / display.wheelDY) ||
            (movedX && display.wheelDX && movedX / display.wheelDX);
          display.wheelStartX = display.wheelStartY = null;
          if (!sample) return;
          wheelPixelsPerUnit = (wheelPixelsPerUnit * wheelSamples + sample) / (wheelSamples + 1);
          ++wheelSamples;
        }, 200);
      } else {
        display.wheelDX += dx; display.wheelDY += dy;
      }
    }
  }

  // KEY EVENTS

  // Run a handler that was bound to a key.
  function doHandleBinding(cm, bound, dropShift) {
    if (typeof bound == "string") {
      bound = commands[bound];
      if (!bound) return false;
    }
    // Ensure previous input has been read, so that the handler sees a
    // consistent view of the document
    if (cm.display.pollingFast && readInput(cm)) cm.display.pollingFast = false;
    var prevShift = cm.display.shift, done = false;
    try {
      if (isReadOnly(cm)) cm.state.suppressEdits = true;
      if (dropShift) cm.display.shift = false;
      done = bound(cm) != Pass;
    } finally {
      cm.display.shift = prevShift;
      cm.state.suppressEdits = false;
    }
    return done;
  }

  // Collect the currently active keymaps.
  function allKeyMaps(cm) {
    var maps = cm.state.keyMaps.slice(0);
    if (cm.options.extraKeys) maps.push(cm.options.extraKeys);
    maps.push(cm.options.keyMap);
    return maps;
  }

  var maybeTransition;
  // Handle a key from the keydown event.
  function handleKeyBinding(cm, e) {
    // Handle automatic keymap transitions
    var startMap = getKeyMap(cm.options.keyMap), next = startMap.auto;
    clearTimeout(maybeTransition);
    if (next && !isModifierKey(e)) maybeTransition = setTimeout(function() {
      if (getKeyMap(cm.options.keyMap) == startMap) {
        cm.options.keyMap = (next.call ? next.call(null, cm) : next);
        keyMapChanged(cm);
      }
    }, 50);

    var name = keyName(e, true), handled = false;
    if (!name) return false;
    var keymaps = allKeyMaps(cm);

    if (e.shiftKey) {
      // First try to resolve full name (including 'Shift-'). Failing
      // that, see if there is a cursor-motion command (starting with
      // 'go') bound to the keyname without 'Shift-'.
      handled = lookupKey("Shift-" + name, keymaps, function(b) {return doHandleBinding(cm, b, true);})
             || lookupKey(name, keymaps, function(b) {
                  if (typeof b == "string" ? /^go[A-Z]/.test(b) : b.motion)
                    return doHandleBinding(cm, b);
                });
    } else {
      handled = lookupKey(name, keymaps, function(b) { return doHandleBinding(cm, b); });
    }

    if (handled) {
      e_preventDefault(e);
      restartBlink(cm);
      signalLater(cm, "keyHandled", cm, name, e);
    }
    return handled;
  }

  // Handle a key from the keypress event
  function handleCharBinding(cm, e, ch) {
    var handled = lookupKey("'" + ch + "'", allKeyMaps(cm),
                            function(b) { return doHandleBinding(cm, b, true); });
    if (handled) {
      e_preventDefault(e);
      restartBlink(cm);
      signalLater(cm, "keyHandled", cm, "'" + ch + "'", e);
    }
    return handled;
  }

  var lastStoppedKey = null;
  function onKeyDown(e) {
    var cm = this;
    ensureFocus(cm);
    if (signalDOMEvent(cm, e)) return;
    // IE does strange things with escape.
    if (ie && ie_version < 11 && e.keyCode == 27) e.returnValue = false;
    var code = e.keyCode;
    cm.display.shift = code == 16 || e.shiftKey;
    var handled = handleKeyBinding(cm, e);
    if (presto) {
      lastStoppedKey = handled ? code : null;
      // Opera has no cut event... we try to at least catch the key combo
      if (!handled && code == 88 && !hasCopyEvent && (mac ? e.metaKey : e.ctrlKey))
        cm.replaceSelection("", null, "cut");
    }

    // Turn mouse into crosshair when Alt is held on Mac.
    if (code == 18 && !/\bCodeMirror-crosshair\b/.test(cm.display.lineDiv.className))
      showCrossHair(cm);
  }

  function showCrossHair(cm) {
    var lineDiv = cm.display.lineDiv;
    addClass(lineDiv, "CodeMirror-crosshair");

    function up(e) {
      if (e.keyCode == 18 || !e.altKey) {
        rmClass(lineDiv, "CodeMirror-crosshair");
        off(document, "keyup", up);
        off(document, "mouseover", up);
      }
    }
    on(document, "keyup", up);
    on(document, "mouseover", up);
  }

  function onKeyUp(e) {
    if (e.keyCode == 16) this.doc.sel.shift = false;
    signalDOMEvent(this, e);
  }

  function onKeyPress(e) {
    var cm = this;
    if (signalDOMEvent(cm, e) || e.ctrlKey && !e.altKey || mac && e.metaKey) return;
    var keyCode = e.keyCode, charCode = e.charCode;
    if (presto && keyCode == lastStoppedKey) {lastStoppedKey = null; e_preventDefault(e); return;}
    if (((presto && (!e.which || e.which < 10)) || khtml) && handleKeyBinding(cm, e)) return;
    var ch = String.fromCharCode(charCode == null ? keyCode : charCode);
    if (handleCharBinding(cm, e, ch)) return;
    if (ie && ie_version >= 9) cm.display.inputHasSelection = null;
    fastPoll(cm);
  }

  // FOCUS/BLUR EVENTS

  function onFocus(cm) {
    if (cm.options.readOnly == "nocursor") return;
    if (!cm.state.focused) {
      signal(cm, "focus", cm);
      cm.state.focused = true;
      addClass(cm.display.wrapper, "CodeMirror-focused");
      // The prevInput test prevents this from firing when a context
      // menu is closed (since the resetInput would kill the
      // select-all detection hack)
      if (!cm.curOp && cm.display.selForContextMenu != cm.doc.sel) {
        resetInput(cm);
        if (webkit) setTimeout(bind(resetInput, cm, true), 0); // Issue #1730
      }
    }
    slowPoll(cm);
    restartBlink(cm);
  }
  function onBlur(cm) {
    if (cm.state.focused) {
      signal(cm, "blur", cm);
      cm.state.focused = false;
      rmClass(cm.display.wrapper, "CodeMirror-focused");
    }
    clearInterval(cm.display.blinker);
    setTimeout(function() {if (!cm.state.focused) cm.display.shift = false;}, 150);
  }

  // CONTEXT MENU HANDLING

  // To make the context menu work, we need to briefly unhide the
  // textarea (making it as unobtrusive as possible) to let the
  // right-click take effect on it.
  function onContextMenu(cm, e) {
    if (signalDOMEvent(cm, e, "contextmenu")) return;
    var display = cm.display;
    if (eventInWidget(display, e) || contextMenuInGutter(cm, e)) return;

    var pos = posFromMouse(cm, e), scrollPos = display.scroller.scrollTop;
    if (!pos || presto) return; // Opera is difficult.

    // Reset the current text selection only if the click is done outside of the selection
    // and 'resetSelectionOnContextMenu' option is true.
    var reset = cm.options.resetSelectionOnContextMenu;
    if (reset && cm.doc.sel.contains(pos) == -1)
      operation(cm, setSelection)(cm.doc, simpleSelection(pos), sel_dontScroll);

    var oldCSS = display.input.style.cssText;
    display.inputDiv.style.position = "absolute";
    display.input.style.cssText = "position: fixed; width: 30px; height: 30px; top: " + (e.clientY - 5) +
      "px; left: " + (e.clientX - 5) + "px; z-index: 1000; background: " +
      (ie ? "rgba(255, 255, 255, .05)" : "transparent") +
      "; outline: none; border-width: 0; outline: none; overflow: hidden; opacity: .05; filter: alpha(opacity=5);";
    if (webkit) var oldScrollY = window.scrollY; // Work around Chrome issue (#2712)
    focusInput(cm);
    if (webkit) window.scrollTo(null, oldScrollY);
    resetInput(cm);
    // Adds "Select all" to context menu in FF
    if (!cm.somethingSelected()) display.input.value = display.prevInput = " ";
    display.selForContextMenu = cm.doc.sel;
    clearTimeout(display.detectingSelectAll);

    // Select-all will be greyed out if there's nothing to select, so
    // this adds a zero-width space so that we can later check whether
    // it got selected.
    function prepareSelectAllHack() {
      if (display.input.selectionStart != null) {
        var selected = cm.somethingSelected();
        var extval = display.input.value = "\u200b" + (selected ? display.input.value : "");
        display.prevInput = selected ? "" : "\u200b";
        display.input.selectionStart = 1; display.input.selectionEnd = extval.length;
        // Re-set this, in case some other handler touched the
        // selection in the meantime.
        display.selForContextMenu = cm.doc.sel;
      }
    }
    function rehide() {
      display.inputDiv.style.position = "relative";
      display.input.style.cssText = oldCSS;
      if (ie && ie_version < 9) display.scrollbarV.scrollTop = display.scroller.scrollTop = scrollPos;
      slowPoll(cm);

      // Try to detect the user choosing select-all
      if (display.input.selectionStart != null) {
        if (!ie || (ie && ie_version < 9)) prepareSelectAllHack();
        var i = 0, poll = function() {
          if (display.selForContextMenu == cm.doc.sel && display.input.selectionStart == 0)
            operation(cm, commands.selectAll)(cm);
          else if (i++ < 10) display.detectingSelectAll = setTimeout(poll, 500);
          else resetInput(cm);
        };
        display.detectingSelectAll = setTimeout(poll, 200);
      }
    }

    if (ie && ie_version >= 9) prepareSelectAllHack();
    if (captureRightClick) {
      e_stop(e);
      var mouseup = function() {
        off(window, "mouseup", mouseup);
        setTimeout(rehide, 20);
      };
      on(window, "mouseup", mouseup);
    } else {
      setTimeout(rehide, 50);
    }
  }

  function contextMenuInGutter(cm, e) {
    if (!hasHandler(cm, "gutterContextMenu")) return false;
    return gutterEvent(cm, e, "gutterContextMenu", false, signal);
  }

  // UPDATING

  // Compute the position of the end of a change (its 'to' property
  // refers to the pre-change end).
  var changeEnd = CodeMirror.changeEnd = function(change) {
    if (!change.text) return change.to;
    return Pos(change.from.line + change.text.length - 1,
               lst(change.text).length + (change.text.length == 1 ? change.from.ch : 0));
  };

  // Adjust a position to refer to the post-change position of the
  // same text, or the end of the change if the change covers it.
  function adjustForChange(pos, change) {
    if (cmp(pos, change.from) < 0) return pos;
    if (cmp(pos, change.to) <= 0) return changeEnd(change);

    var line = pos.line + change.text.length - (change.to.line - change.from.line) - 1, ch = pos.ch;
    if (pos.line == change.to.line) ch += changeEnd(change).ch - change.to.ch;
    return Pos(line, ch);
  }

  function computeSelAfterChange(doc, change) {
    var out = [];
    for (var i = 0; i < doc.sel.ranges.length; i++) {
      var range = doc.sel.ranges[i];
      out.push(new Range(adjustForChange(range.anchor, change),
                         adjustForChange(range.head, change)));
    }
    return normalizeSelection(out, doc.sel.primIndex);
  }

  function offsetPos(pos, old, nw) {
    if (pos.line == old.line)
      return Pos(nw.line, pos.ch - old.ch + nw.ch);
    else
      return Pos(nw.line + (pos.line - old.line), pos.ch);
  }

  // Used by replaceSelections to allow moving the selection to the
  // start or around the replaced test. Hint may be "start" or "around".
  function computeReplacedSel(doc, changes, hint) {
    var out = [];
    var oldPrev = Pos(doc.first, 0), newPrev = oldPrev;
    for (var i = 0; i < changes.length; i++) {
      var change = changes[i];
      var from = offsetPos(change.from, oldPrev, newPrev);
      var to = offsetPos(changeEnd(change), oldPrev, newPrev);
      oldPrev = change.to;
      newPrev = to;
      if (hint == "around") {
        var range = doc.sel.ranges[i], inv = cmp(range.head, range.anchor) < 0;
        out[i] = new Range(inv ? to : from, inv ? from : to);
      } else {
        out[i] = new Range(from, from);
      }
    }
    return new Selection(out, doc.sel.primIndex);
  }

  // Allow "beforeChange" event handlers to influence a change
  function filterChange(doc, change, update) {
    var obj = {
      canceled: false,
      from: change.from,
      to: change.to,
      text: change.text,
      origin: change.origin,
      cancel: function() { this.canceled = true; }
    };
    if (update) obj.update = function(from, to, text, origin) {
      if (from) this.from = clipPos(doc, from);
      if (to) this.to = clipPos(doc, to);
      if (text) this.text = text;
      if (origin !== undefined) this.origin = origin;
    };
    signal(doc, "beforeChange", doc, obj);
    if (doc.cm) signal(doc.cm, "beforeChange", doc.cm, obj);

    if (obj.canceled) return null;
    return {from: obj.from, to: obj.to, text: obj.text, origin: obj.origin};
  }

  // Apply a change to a document, and add it to the document's
  // history, and propagating it to all linked documents.
  function makeChange(doc, change, ignoreReadOnly) {
    if (doc.cm) {
      if (!doc.cm.curOp) return operation(doc.cm, makeChange)(doc, change, ignoreReadOnly);
      if (doc.cm.state.suppressEdits) return;
    }

    if (hasHandler(doc, "beforeChange") || doc.cm && hasHandler(doc.cm, "beforeChange")) {
      change = filterChange(doc, change, true);
      if (!change) return;
    }

    // Possibly split or suppress the update based on the presence
    // of read-only spans in its range.
    var split = sawReadOnlySpans && !ignoreReadOnly && removeReadOnlyRanges(doc, change.from, change.to);
    if (split) {
      for (var i = split.length - 1; i >= 0; --i)
        makeChangeInner(doc, {from: split[i].from, to: split[i].to, text: i ? [""] : change.text});
    } else {
      makeChangeInner(doc, change);
    }
  }

  function makeChangeInner(doc, change) {
    if (change.text.length == 1 && change.text[0] == "" && cmp(change.from, change.to) == 0) return;
    var selAfter = computeSelAfterChange(doc, change);
    addChangeToHistory(doc, change, selAfter, doc.cm ? doc.cm.curOp.id : NaN);

    makeChangeSingleDoc(doc, change, selAfter, stretchSpansOverChange(doc, change));
    var rebased = [];

    linkedDocs(doc, function(doc, sharedHist) {
      if (!sharedHist && indexOf(rebased, doc.history) == -1) {
        rebaseHist(doc.history, change);
        rebased.push(doc.history);
      }
      makeChangeSingleDoc(doc, change, null, stretchSpansOverChange(doc, change));
    });
  }

  // Revert a change stored in a document's history.
  function makeChangeFromHistory(doc, type, allowSelectionOnly) {
    if (doc.cm && doc.cm.state.suppressEdits) return;

    var hist = doc.history, event, selAfter = doc.sel;
    var source = type == "undo" ? hist.done : hist.undone, dest = type == "undo" ? hist.undone : hist.done;

    // Verify that there is a useable event (so that ctrl-z won't
    // needlessly clear selection events)
    for (var i = 0; i < source.length; i++) {
      event = source[i];
      if (allowSelectionOnly ? event.ranges && !event.equals(doc.sel) : !event.ranges)
        break;
    }
    if (i == source.length) return;
    hist.lastOrigin = hist.lastSelOrigin = null;

    for (;;) {
      event = source.pop();
      if (event.ranges) {
        pushSelectionToHistory(event, dest);
        if (allowSelectionOnly && !event.equals(doc.sel)) {
          setSelection(doc, event, {clearRedo: false});
          return;
        }
        selAfter = event;
      }
      else break;
    }

    // Build up a reverse change object to add to the opposite history
    // stack (redo when undoing, and vice versa).
    var antiChanges = [];
    pushSelectionToHistory(selAfter, dest);
    dest.push({changes: antiChanges, generation: hist.generation});
    hist.generation = event.generation || ++hist.maxGeneration;

    var filter = hasHandler(doc, "beforeChange") || doc.cm && hasHandler(doc.cm, "beforeChange");

    for (var i = event.changes.length - 1; i >= 0; --i) {
      var change = event.changes[i];
      change.origin = type;
      if (filter && !filterChange(doc, change, false)) {
        source.length = 0;
        return;
      }

      antiChanges.push(historyChangeFromChange(doc, change));

      var after = i ? computeSelAfterChange(doc, change) : lst(source);
      makeChangeSingleDoc(doc, change, after, mergeOldSpans(doc, change));
      if (!i && doc.cm) doc.cm.scrollIntoView(change);
      var rebased = [];

      // Propagate to the linked documents
      linkedDocs(doc, function(doc, sharedHist) {
        if (!sharedHist && indexOf(rebased, doc.history) == -1) {
          rebaseHist(doc.history, change);
          rebased.push(doc.history);
        }
        makeChangeSingleDoc(doc, change, null, mergeOldSpans(doc, change));
      });
    }
  }

  // Sub-views need their line numbers shifted when text is added
  // above or below them in the parent document.
  function shiftDoc(doc, distance) {
    if (distance == 0) return;
    doc.first += distance;
    doc.sel = new Selection(map(doc.sel.ranges, function(range) {
      return new Range(Pos(range.anchor.line + distance, range.anchor.ch),
                       Pos(range.head.line + distance, range.head.ch));
    }), doc.sel.primIndex);
    if (doc.cm) {
      regChange(doc.cm, doc.first, doc.first - distance, distance);
      for (var d = doc.cm.display, l = d.viewFrom; l < d.viewTo; l++)
        regLineChange(doc.cm, l, "gutter");
    }
  }

  // More lower-level change function, handling only a single document
  // (not linked ones).
  function makeChangeSingleDoc(doc, change, selAfter, spans) {
    if (doc.cm && !doc.cm.curOp)
      return operation(doc.cm, makeChangeSingleDoc)(doc, change, selAfter, spans);

    if (change.to.line < doc.first) {
      shiftDoc(doc, change.text.length - 1 - (change.to.line - change.from.line));
      return;
    }
    if (change.from.line > doc.lastLine()) return;

    // Clip the change to the size of this doc
    if (change.from.line < doc.first) {
      var shift = change.text.length - 1 - (doc.first - change.from.line);
      shiftDoc(doc, shift);
      change = {from: Pos(doc.first, 0), to: Pos(change.to.line + shift, change.to.ch),
                text: [lst(change.text)], origin: change.origin};
    }
    var last = doc.lastLine();
    if (change.to.line > last) {
      change = {from: change.from, to: Pos(last, getLine(doc, last).text.length),
                text: [change.text[0]], origin: change.origin};
    }

    change.removed = getBetween(doc, change.from, change.to);

    if (!selAfter) selAfter = computeSelAfterChange(doc, change);
    if (doc.cm) makeChangeSingleDocInEditor(doc.cm, change, spans);
    else updateDoc(doc, change, spans);
    setSelectionNoUndo(doc, selAfter, sel_dontScroll);
  }

  // Handle the interaction of a change to a document with the editor
  // that this document is part of.
  function makeChangeSingleDocInEditor(cm, change, spans) {
    var doc = cm.doc, display = cm.display, from = change.from, to = change.to;

    var recomputeMaxLength = false, checkWidthStart = from.line;
    if (!cm.options.lineWrapping) {
      checkWidthStart = lineNo(visualLine(getLine(doc, from.line)));
      doc.iter(checkWidthStart, to.line + 1, function(line) {
        if (line == display.maxLine) {
          recomputeMaxLength = true;
          return true;
        }
      });
    }

    if (doc.sel.contains(change.from, change.to) > -1)
      signalCursorActivity(cm);

    updateDoc(doc, change, spans, estimateHeight(cm));

    if (!cm.options.lineWrapping) {
      doc.iter(checkWidthStart, from.line + change.text.length, function(line) {
        var len = lineLength(line);
        if (len > display.maxLineLength) {
          display.maxLine = line;
          display.maxLineLength = len;
          display.maxLineChanged = true;
          recomputeMaxLength = false;
        }
      });
      if (recomputeMaxLength) cm.curOp.updateMaxLine = true;
    }

    // Adjust frontier, schedule worker
    doc.frontier = Math.min(doc.frontier, from.line);
    startWorker(cm, 400);

    var lendiff = change.text.length - (to.line - from.line) - 1;
    // Remember that these lines changed, for updating the display
    if (from.line == to.line && change.text.length == 1 && !isWholeLineUpdate(cm.doc, change))
      regLineChange(cm, from.line, "text");
    else
      regChange(cm, from.line, to.line + 1, lendiff);

    var changesHandler = hasHandler(cm, "changes"), changeHandler = hasHandler(cm, "change");
    if (changeHandler || changesHandler) {
      var obj = {
        from: from, to: to,
        text: change.text,
        removed: change.removed,
        origin: change.origin
      };
      if (changeHandler) signalLater(cm, "change", cm, obj);
      if (changesHandler) (cm.curOp.changeObjs || (cm.curOp.changeObjs = [])).push(obj);
    }
    cm.display.selForContextMenu = null;
  }

  function replaceRange(doc, code, from, to, origin) {
    if (!to) to = from;
    if (cmp(to, from) < 0) { var tmp = to; to = from; from = tmp; }
    if (typeof code == "string") code = splitLines(code);
    makeChange(doc, {from: from, to: to, text: code, origin: origin});
  }

  // SCROLLING THINGS INTO VIEW

  // If an editor sits on the top or bottom of the window, partially
  // scrolled out of view, this ensures that the cursor is visible.
  function maybeScrollWindow(cm, coords) {
    var display = cm.display, box = display.sizer.getBoundingClientRect(), doScroll = null;
    if (coords.top + box.top < 0) doScroll = true;
    else if (coords.bottom + box.top > (window.innerHeight || document.documentElement.clientHeight)) doScroll = false;
    if (doScroll != null && !phantom) {
      var scrollNode = elt("div", "\u200b", null, "position: absolute; top: " +
                           (coords.top - display.viewOffset - paddingTop(cm.display)) + "px; height: " +
                           (coords.bottom - coords.top + scrollerCutOff) + "px; left: " +
                           coords.left + "px; width: 2px;");
      cm.display.lineSpace.appendChild(scrollNode);
      scrollNode.scrollIntoView(doScroll);
      cm.display.lineSpace.removeChild(scrollNode);
    }
  }

  // Scroll a given position into view (immediately), verifying that
  // it actually became visible (as line heights are accurately
  // measured, the position of something may 'drift' during drawing).
  function scrollPosIntoView(cm, pos, end, margin) {
    if (margin == null) margin = 0;
    for (;;) {
      var changed = false, coords = cursorCoords(cm, pos);
      var endCoords = !end || end == pos ? coords : cursorCoords(cm, end);
      var scrollPos = calculateScrollPos(cm, Math.min(coords.left, endCoords.left),
                                         Math.min(coords.top, endCoords.top) - margin,
                                         Math.max(coords.left, endCoords.left),
                                         Math.max(coords.bottom, endCoords.bottom) + margin);
      var startTop = cm.doc.scrollTop, startLeft = cm.doc.scrollLeft;
      if (scrollPos.scrollTop != null) {
        setScrollTop(cm, scrollPos.scrollTop);
        if (Math.abs(cm.doc.scrollTop - startTop) > 1) changed = true;
      }
      if (scrollPos.scrollLeft != null) {
        setScrollLeft(cm, scrollPos.scrollLeft);
        if (Math.abs(cm.doc.scrollLeft - startLeft) > 1) changed = true;
      }
      if (!changed) return coords;
    }
  }

  // Scroll a given set of coordinates into view (immediately).
  function scrollIntoView(cm, x1, y1, x2, y2) {
    var scrollPos = calculateScrollPos(cm, x1, y1, x2, y2);
    if (scrollPos.scrollTop != null) setScrollTop(cm, scrollPos.scrollTop);
    if (scrollPos.scrollLeft != null) setScrollLeft(cm, scrollPos.scrollLeft);
  }

  // Calculate a new scroll position needed to scroll the given
  // rectangle into view. Returns an object with scrollTop and
  // scrollLeft properties. When these are undefined, the
  // vertical/horizontal position does not need to be adjusted.
  function calculateScrollPos(cm, x1, y1, x2, y2) {
    var display = cm.display, snapMargin = textHeight(cm.display);
    if (y1 < 0) y1 = 0;
    var screentop = cm.curOp && cm.curOp.scrollTop != null ? cm.curOp.scrollTop : display.scroller.scrollTop;
    var screen = display.scroller.clientHeight - scrollerCutOff, result = {};
    var docBottom = cm.doc.height + paddingVert(display);
    var atTop = y1 < snapMargin, atBottom = y2 > docBottom - snapMargin;
    if (y1 < screentop) {
      result.scrollTop = atTop ? 0 : y1;
    } else if (y2 > screentop + screen) {
      var newTop = Math.min(y1, (atBottom ? docBottom : y2) - screen);
      if (newTop != screentop) result.scrollTop = newTop;
    }

    var screenleft = cm.curOp && cm.curOp.scrollLeft != null ? cm.curOp.scrollLeft : display.scroller.scrollLeft;
    var screenw = display.scroller.clientWidth - scrollerCutOff;
    x1 += display.gutters.offsetWidth; x2 += display.gutters.offsetWidth;
    var gutterw = display.gutters.offsetWidth;
    var atLeft = x1 < gutterw + 10;
    if (x1 < screenleft + gutterw || atLeft) {
      if (atLeft) x1 = 0;
      result.scrollLeft = Math.max(0, x1 - 10 - gutterw);
    } else if (x2 > screenw + screenleft - 3) {
      result.scrollLeft = x2 + 10 - screenw;
    }
    return result;
  }

  // Store a relative adjustment to the scroll position in the current
  // operation (to be applied when the operation finishes).
  function addToScrollPos(cm, left, top) {
    if (left != null || top != null) resolveScrollToPos(cm);
    if (left != null)
      cm.curOp.scrollLeft = (cm.curOp.scrollLeft == null ? cm.doc.scrollLeft : cm.curOp.scrollLeft) + left;
    if (top != null)
      cm.curOp.scrollTop = (cm.curOp.scrollTop == null ? cm.doc.scrollTop : cm.curOp.scrollTop) + top;
  }

  // Make sure that at the end of the operation the current cursor is
  // shown.
  function ensureCursorVisible(cm) {
    resolveScrollToPos(cm);
    var cur = cm.getCursor(), from = cur, to = cur;
    if (!cm.options.lineWrapping) {
      from = cur.ch ? Pos(cur.line, cur.ch - 1) : cur;
      to = Pos(cur.line, cur.ch + 1);
    }
    cm.curOp.scrollToPos = {from: from, to: to, margin: cm.options.cursorScrollMargin, isCursor: true};
  }

  // When an operation has its scrollToPos property set, and another
  // scroll action is applied before the end of the operation, this
  // 'simulates' scrolling that position into view in a cheap way, so
  // that the effect of intermediate scroll commands is not ignored.
  function resolveScrollToPos(cm) {
    var range = cm.curOp.scrollToPos;
    if (range) {
      cm.curOp.scrollToPos = null;
      var from = estimateCoords(cm, range.from), to = estimateCoords(cm, range.to);
      var sPos = calculateScrollPos(cm, Math.min(from.left, to.left),
                                    Math.min(from.top, to.top) - range.margin,
                                    Math.max(from.right, to.right),
                                    Math.max(from.bottom, to.bottom) + range.margin);
      cm.scrollTo(sPos.scrollLeft, sPos.scrollTop);
    }
  }

  // API UTILITIES

  // Indent the given line. The how parameter can be "smart",
  // "add"/null, "subtract", or "prev". When aggressive is false
  // (typically set to true for forced single-line indents), empty
  // lines are not indented, and places where the mode returns Pass
  // are left alone.
  function indentLine(cm, n, how, aggressive) {
    var doc = cm.doc, state;
    if (how == null) how = "add";
    if (how == "smart") {
      // Fall back to "prev" when the mode doesn't have an indentation
      // method.
      if (!doc.mode.indent) how = "prev";
      else state = getStateBefore(cm, n);
    }

    var tabSize = cm.options.tabSize;
    var line = getLine(doc, n), curSpace = countColumn(line.text, null, tabSize);
    if (line.stateAfter) line.stateAfter = null;
    var curSpaceString = line.text.match(/^\s*/)[0], indentation;
    if (!aggressive && !/\S/.test(line.text)) {
      indentation = 0;
      how = "not";
    } else if (how == "smart") {
      indentation = doc.mode.indent(state, line.text.slice(curSpaceString.length), line.text);
      if (indentation == Pass || indentation > 150) {
        if (!aggressive) return;
        how = "prev";
      }
    }
    if (how == "prev") {
      if (n > doc.first) indentation = countColumn(getLine(doc, n-1).text, null, tabSize);
      else indentation = 0;
    } else if (how == "add") {
      indentation = curSpace + cm.options.indentUnit;
    } else if (how == "subtract") {
      indentation = curSpace - cm.options.indentUnit;
    } else if (typeof how == "number") {
      indentation = curSpace + how;
    }
    indentation = Math.max(0, indentation);

    var indentString = "", pos = 0;
    if (cm.options.indentWithTabs)
      for (var i = Math.floor(indentation / tabSize); i; --i) {pos += tabSize; indentString += "\t";}
    if (pos < indentation) indentString += spaceStr(indentation - pos);

    if (indentString != curSpaceString) {
      replaceRange(doc, indentString, Pos(n, 0), Pos(n, curSpaceString.length), "+input");
    } else {
      // Ensure that, if the cursor was in the whitespace at the start
      // of the line, it is moved to the end of that space.
      for (var i = 0; i < doc.sel.ranges.length; i++) {
        var range = doc.sel.ranges[i];
        if (range.head.line == n && range.head.ch < curSpaceString.length) {
          var pos = Pos(n, curSpaceString.length);
          replaceOneSelection(doc, i, new Range(pos, pos));
          break;
        }
      }
    }
    line.stateAfter = null;
  }

  // Utility for applying a change to a line by handle or number,
  // returning the number and optionally registering the line as
  // changed.
  function changeLine(doc, handle, changeType, op) {
    var no = handle, line = handle;
    if (typeof handle == "number") line = getLine(doc, clipLine(doc, handle));
    else no = lineNo(handle);
    if (no == null) return null;
    if (op(line, no) && doc.cm) regLineChange(doc.cm, no, changeType);
    return line;
  }

  // Helper for deleting text near the selection(s), used to implement
  // backspace, delete, and similar functionality.
  function deleteNearSelection(cm, compute) {
    var ranges = cm.doc.sel.ranges, kill = [];
    // Build up a set of ranges to kill first, merging overlapping
    // ranges.
    for (var i = 0; i < ranges.length; i++) {
      var toKill = compute(ranges[i]);
      while (kill.length && cmp(toKill.from, lst(kill).to) <= 0) {
        var replaced = kill.pop();
        if (cmp(replaced.from, toKill.from) < 0) {
          toKill.from = replaced.from;
          break;
        }
      }
      kill.push(toKill);
    }
    // Next, remove those actual ranges.
    runInOp(cm, function() {
      for (var i = kill.length - 1; i >= 0; i--)
        replaceRange(cm.doc, "", kill[i].from, kill[i].to, "+delete");
      ensureCursorVisible(cm);
    });
  }

  // Used for horizontal relative motion. Dir is -1 or 1 (left or
  // right), unit can be "char", "column" (like char, but doesn't
  // cross line boundaries), "word" (across next word), or "group" (to
  // the start of next group of word or non-word-non-whitespace
  // chars). The visually param controls whether, in right-to-left
  // text, direction 1 means to move towards the next index in the
  // string, or towards the character to the right of the current
  // position. The resulting position will have a hitSide=true
  // property if it reached the end of the document.
  function findPosH(doc, pos, dir, unit, visually) {
    var line = pos.line, ch = pos.ch, origDir = dir;
    var lineObj = getLine(doc, line);
    var possible = true;
    function findNextLine() {
      var l = line + dir;
      if (l < doc.first || l >= doc.first + doc.size) return (possible = false);
      line = l;
      return lineObj = getLine(doc, l);
    }
    function moveOnce(boundToLine) {
      var next = (visually ? moveVisually : moveLogically)(lineObj, ch, dir, true);
      if (next == null) {
        if (!boundToLine && findNextLine()) {
          if (visually) ch = (dir < 0 ? lineRight : lineLeft)(lineObj);
          else ch = dir < 0 ? lineObj.text.length : 0;
        } else return (possible = false);
      } else ch = next;
      return true;
    }

    if (unit == "char") moveOnce();
    else if (unit == "column") moveOnce(true);
    else if (unit == "word" || unit == "group") {
      var sawType = null, group = unit == "group";
      var helper = doc.cm && doc.cm.getHelper(pos, "wordChars");
      for (var first = true;; first = false) {
        if (dir < 0 && !moveOnce(!first)) break;
        var cur = lineObj.text.charAt(ch) || "\n";
        var type = isWordChar(cur, helper) ? "w"
          : group && cur == "\n" ? "n"
          : !group || /\s/.test(cur) ? null
          : "p";
        if (group && !first && !type) type = "s";
        if (sawType && sawType != type) {
          if (dir < 0) {dir = 1; moveOnce();}
          break;
        }

        if (type) sawType = type;
        if (dir > 0 && !moveOnce(!first)) break;
      }
    }
    var result = skipAtomic(doc, Pos(line, ch), origDir, true);
    if (!possible) result.hitSide = true;
    return result;
  }

  // For relative vertical movement. Dir may be -1 or 1. Unit can be
  // "page" or "line". The resulting position will have a hitSide=true
  // property if it reached the end of the document.
  function findPosV(cm, pos, dir, unit) {
    var doc = cm.doc, x = pos.left, y;
    if (unit == "page") {
      var pageSize = Math.min(cm.display.wrapper.clientHeight, window.innerHeight || document.documentElement.clientHeight);
      y = pos.top + dir * (pageSize - (dir < 0 ? 1.5 : .5) * textHeight(cm.display));
    } else if (unit == "line") {
      y = dir > 0 ? pos.bottom + 3 : pos.top - 3;
    }
    for (;;) {
      var target = coordsChar(cm, x, y);
      if (!target.outside) break;
      if (dir < 0 ? y <= 0 : y >= doc.height) { target.hitSide = true; break; }
      y += dir * 5;
    }
    return target;
  }

  // Find the word at the given position (as returned by coordsChar).
  function findWordAt(cm, pos) {
    var doc = cm.doc, line = getLine(doc, pos.line).text;
    var start = pos.ch, end = pos.ch;
    if (line) {
      var helper = cm.getHelper(pos, "wordChars");
      if ((pos.xRel < 0 || end == line.length) && start) --start; else ++end;
      var startChar = line.charAt(start);
      var check = isWordChar(startChar, helper)
        ? function(ch) { return isWordChar(ch, helper); }
        : /\s/.test(startChar) ? function(ch) {return /\s/.test(ch);}
        : function(ch) {return !/\s/.test(ch) && !isWordChar(ch);};
      while (start > 0 && check(line.charAt(start - 1))) --start;
      while (end < line.length && check(line.charAt(end))) ++end;
    }
    return new Range(Pos(pos.line, start), Pos(pos.line, end));
  }

  // EDITOR METHODS

  // The publicly visible API. Note that methodOp(f) means
  // 'wrap f in an operation, performed on its `this` parameter'.

  // This is not the complete set of editor methods. Most of the
  // methods defined on the Doc type are also injected into
  // CodeMirror.prototype, for backwards compatibility and
  // convenience.

  CodeMirror.prototype = {
    constructor: CodeMirror,
    focus: function(){window.focus(); focusInput(this); fastPoll(this);},

    setOption: function(option, value) {
      var options = this.options, old = options[option];
      if (options[option] == value && option != "mode") return;
      options[option] = value;
      if (optionHandlers.hasOwnProperty(option))
        operation(this, optionHandlers[option])(this, value, old);
    },

    getOption: function(option) {return this.options[option];},
    getDoc: function() {return this.doc;},

    addKeyMap: function(map, bottom) {
      this.state.keyMaps[bottom ? "push" : "unshift"](map);
    },
    removeKeyMap: function(map) {
      var maps = this.state.keyMaps;
      for (var i = 0; i < maps.length; ++i)
        if (maps[i] == map || (typeof maps[i] != "string" && maps[i].name == map)) {
          maps.splice(i, 1);
          return true;
        }
    },

    addOverlay: methodOp(function(spec, options) {
      var mode = spec.token ? spec : CodeMirror.getMode(this.options, spec);
      if (mode.startState) throw new Error("Overlays may not be stateful.");
      this.state.overlays.push({mode: mode, modeSpec: spec, opaque: options && options.opaque});
      this.state.modeGen++;
      regChange(this);
    }),
    removeOverlay: methodOp(function(spec) {
      var overlays = this.state.overlays;
      for (var i = 0; i < overlays.length; ++i) {
        var cur = overlays[i].modeSpec;
        if (cur == spec || typeof spec == "string" && cur.name == spec) {
          overlays.splice(i, 1);
          this.state.modeGen++;
          regChange(this);
          return;
        }
      }
    }),

    indentLine: methodOp(function(n, dir, aggressive) {
      if (typeof dir != "string" && typeof dir != "number") {
        if (dir == null) dir = this.options.smartIndent ? "smart" : "prev";
        else dir = dir ? "add" : "subtract";
      }
      if (isLine(this.doc, n)) indentLine(this, n, dir, aggressive);
    }),
    indentSelection: methodOp(function(how) {
      var ranges = this.doc.sel.ranges, end = -1;
      for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i];
        if (!range.empty()) {
          var start = Math.max(end, range.from().line);
          var to = range.to();
          end = Math.min(this.lastLine(), to.line - (to.ch ? 0 : 1)) + 1;
          for (var j = start; j < end; ++j)
            indentLine(this, j, how);
        } else if (range.head.line > end) {
          indentLine(this, range.head.line, how, true);
          end = range.head.line;
          if (i == this.doc.sel.primIndex) ensureCursorVisible(this);
        }
      }
    }),

    // Fetch the parser token for a given character. Useful for hacks
    // that want to inspect the mode state (say, for completion).
    getTokenAt: function(pos, precise) {
      var doc = this.doc;
      pos = clipPos(doc, pos);
      var state = getStateBefore(this, pos.line, precise), mode = this.doc.mode;
      var line = getLine(doc, pos.line);
      var stream = new StringStream(line.text, this.options.tabSize);
      while (stream.pos < pos.ch && !stream.eol()) {
        stream.start = stream.pos;
        var style = readToken(mode, stream, state);
      }
      return {start: stream.start,
              end: stream.pos,
              string: stream.current(),
              type: style || null,
              state: state};
    },

    getTokenTypeAt: function(pos) {
      pos = clipPos(this.doc, pos);
      var styles = getLineStyles(this, getLine(this.doc, pos.line));
      var before = 0, after = (styles.length - 1) / 2, ch = pos.ch;
      var type;
      if (ch == 0) type = styles[2];
      else for (;;) {
        var mid = (before + after) >> 1;
        if ((mid ? styles[mid * 2 - 1] : 0) >= ch) after = mid;
        else if (styles[mid * 2 + 1] < ch) before = mid + 1;
        else { type = styles[mid * 2 + 2]; break; }
      }
      var cut = type ? type.indexOf("cm-overlay ") : -1;
      return cut < 0 ? type : cut == 0 ? null : type.slice(0, cut - 1);
    },

    getModeAt: function(pos) {
      var mode = this.doc.mode;
      if (!mode.innerMode) return mode;
      return CodeMirror.innerMode(mode, this.getTokenAt(pos).state).mode;
    },

    getHelper: function(pos, type) {
      return this.getHelpers(pos, type)[0];
    },

    getHelpers: function(pos, type) {
      var found = [];
      if (!helpers.hasOwnProperty(type)) return helpers;
      var help = helpers[type], mode = this.getModeAt(pos);
      if (typeof mode[type] == "string") {
        if (help[mode[type]]) found.push(help[mode[type]]);
      } else if (mode[type]) {
        for (var i = 0; i < mode[type].length; i++) {
          var val = help[mode[type][i]];
          if (val) found.push(val);
        }
      } else if (mode.helperType && help[mode.helperType]) {
        found.push(help[mode.helperType]);
      } else if (help[mode.name]) {
        found.push(help[mode.name]);
      }
      for (var i = 0; i < help._global.length; i++) {
        var cur = help._global[i];
        if (cur.pred(mode, this) && indexOf(found, cur.val) == -1)
          found.push(cur.val);
      }
      return found;
    },

    getStateAfter: function(line, precise) {
      var doc = this.doc;
      line = clipLine(doc, line == null ? doc.first + doc.size - 1: line);
      return getStateBefore(this, line + 1, precise);
    },

    cursorCoords: function(start, mode) {
      var pos, range = this.doc.sel.primary();
      if (start == null) pos = range.head;
      else if (typeof start == "object") pos = clipPos(this.doc, start);
      else pos = start ? range.from() : range.to();
      return cursorCoords(this, pos, mode || "page");
    },

    charCoords: function(pos, mode) {
      return charCoords(this, clipPos(this.doc, pos), mode || "page");
    },

    coordsChar: function(coords, mode) {
      coords = fromCoordSystem(this, coords, mode || "page");
      return coordsChar(this, coords.left, coords.top);
    },

    lineAtHeight: function(height, mode) {
      height = fromCoordSystem(this, {top: height, left: 0}, mode || "page").top;
      return lineAtHeight(this.doc, height + this.display.viewOffset);
    },
    heightAtLine: function(line, mode) {
      var end = false, last = this.doc.first + this.doc.size - 1;
      if (line < this.doc.first) line = this.doc.first;
      else if (line > last) { line = last; end = true; }
      var lineObj = getLine(this.doc, line);
      return intoCoordSystem(this, lineObj, {top: 0, left: 0}, mode || "page").top +
        (end ? this.doc.height - heightAtLine(lineObj) : 0);
    },

    defaultTextHeight: function() { return textHeight(this.display); },
    defaultCharWidth: function() { return charWidth(this.display); },

    setGutterMarker: methodOp(function(line, gutterID, value) {
      return changeLine(this.doc, line, "gutter", function(line) {
        var markers = line.gutterMarkers || (line.gutterMarkers = {});
        markers[gutterID] = value;
        if (!value && isEmpty(markers)) line.gutterMarkers = null;
        return true;
      });
    }),

    clearGutter: methodOp(function(gutterID) {
      var cm = this, doc = cm.doc, i = doc.first;
      doc.iter(function(line) {
        if (line.gutterMarkers && line.gutterMarkers[gutterID]) {
          line.gutterMarkers[gutterID] = null;
          regLineChange(cm, i, "gutter");
          if (isEmpty(line.gutterMarkers)) line.gutterMarkers = null;
        }
        ++i;
      });
    }),

    addLineWidget: methodOp(function(handle, node, options) {
      return addLineWidget(this, handle, node, options);
    }),

    removeLineWidget: function(widget) { widget.clear(); },

    lineInfo: function(line) {
      if (typeof line == "number") {
        if (!isLine(this.doc, line)) return null;
        var n = line;
        line = getLine(this.doc, line);
        if (!line) return null;
      } else {
        var n = lineNo(line);
        if (n == null) return null;
      }
      return {line: n, handle: line, text: line.text, gutterMarkers: line.gutterMarkers,
              textClass: line.textClass, bgClass: line.bgClass, wrapClass: line.wrapClass,
              widgets: line.widgets};
    },

    getViewport: function() { return {from: this.display.viewFrom, to: this.display.viewTo};},

    addWidget: function(pos, node, scroll, vert, horiz) {
      var display = this.display;
      pos = cursorCoords(this, clipPos(this.doc, pos));
      var top = pos.bottom, left = pos.left;
      node.style.position = "absolute";
      display.sizer.appendChild(node);
      if (vert == "over") {
        top = pos.top;
      } else if (vert == "above" || vert == "near") {
        var vspace = Math.max(display.wrapper.clientHeight, this.doc.height),
        hspace = Math.max(display.sizer.clientWidth, display.lineSpace.clientWidth);
        // Default to positioning above (if specified and possible); otherwise default to positioning below
        if ((vert == 'above' || pos.bottom + node.offsetHeight > vspace) && pos.top > node.offsetHeight)
          top = pos.top - node.offsetHeight;
        else if (pos.bottom + node.offsetHeight <= vspace)
          top = pos.bottom;
        if (left + node.offsetWidth > hspace)
          left = hspace - node.offsetWidth;
      }
      node.style.top = top + "px";
      node.style.left = node.style.right = "";
      if (horiz == "right") {
        left = display.sizer.clientWidth - node.offsetWidth;
        node.style.right = "0px";
      } else {
        if (horiz == "left") left = 0;
        else if (horiz == "middle") left = (display.sizer.clientWidth - node.offsetWidth) / 2;
        node.style.left = left + "px";
      }
      if (scroll)
        scrollIntoView(this, left, top, left + node.offsetWidth, top + node.offsetHeight);
    },

    triggerOnKeyDown: methodOp(onKeyDown),
    triggerOnKeyPress: methodOp(onKeyPress),
    triggerOnKeyUp: onKeyUp,

    execCommand: function(cmd) {
      if (commands.hasOwnProperty(cmd))
        return commands[cmd](this);
    },

    findPosH: function(from, amount, unit, visually) {
      var dir = 1;
      if (amount < 0) { dir = -1; amount = -amount; }
      for (var i = 0, cur = clipPos(this.doc, from); i < amount; ++i) {
        cur = findPosH(this.doc, cur, dir, unit, visually);
        if (cur.hitSide) break;
      }
      return cur;
    },

    moveH: methodOp(function(dir, unit) {
      var cm = this;
      cm.extendSelectionsBy(function(range) {
        if (cm.display.shift || cm.doc.extend || range.empty())
          return findPosH(cm.doc, range.head, dir, unit, cm.options.rtlMoveVisually);
        else
          return dir < 0 ? range.from() : range.to();
      }, sel_move);
    }),

    deleteH: methodOp(function(dir, unit) {
      var sel = this.doc.sel, doc = this.doc;
      if (sel.somethingSelected())
        doc.replaceSelection("", null, "+delete");
      else
        deleteNearSelection(this, function(range) {
          var other = findPosH(doc, range.head, dir, unit, false);
          return dir < 0 ? {from: other, to: range.head} : {from: range.head, to: other};
        });
    }),

    findPosV: function(from, amount, unit, goalColumn) {
      var dir = 1, x = goalColumn;
      if (amount < 0) { dir = -1; amount = -amount; }
      for (var i = 0, cur = clipPos(this.doc, from); i < amount; ++i) {
        var coords = cursorCoords(this, cur, "div");
        if (x == null) x = coords.left;
        else coords.left = x;
        cur = findPosV(this, coords, dir, unit);
        if (cur.hitSide) break;
      }
      return cur;
    },

    moveV: methodOp(function(dir, unit) {
      var cm = this, doc = this.doc, goals = [];
      var collapse = !cm.display.shift && !doc.extend && doc.sel.somethingSelected();
      doc.extendSelectionsBy(function(range) {
        if (collapse)
          return dir < 0 ? range.from() : range.to();
        var headPos = cursorCoords(cm, range.head, "div");
        if (range.goalColumn != null) headPos.left = range.goalColumn;
        goals.push(headPos.left);
        var pos = findPosV(cm, headPos, dir, unit);
        if (unit == "page" && range == doc.sel.primary())
          addToScrollPos(cm, null, charCoords(cm, pos, "div").top - headPos.top);
        return pos;
      }, sel_move);
      if (goals.length) for (var i = 0; i < doc.sel.ranges.length; i++)
        doc.sel.ranges[i].goalColumn = goals[i];
    }),

    toggleOverwrite: function(value) {
      if (value != null && value == this.state.overwrite) return;
      if (this.state.overwrite = !this.state.overwrite)
        addClass(this.display.cursorDiv, "CodeMirror-overwrite");
      else
        rmClass(this.display.cursorDiv, "CodeMirror-overwrite");

      signal(this, "overwriteToggle", this, this.state.overwrite);
    },
    hasFocus: function() { return activeElt() == this.display.input; },

    scrollTo: methodOp(function(x, y) {
      if (x != null || y != null) resolveScrollToPos(this);
      if (x != null) this.curOp.scrollLeft = x;
      if (y != null) this.curOp.scrollTop = y;
    }),
    getScrollInfo: function() {
      var scroller = this.display.scroller, co = scrollerCutOff;
      return {left: scroller.scrollLeft, top: scroller.scrollTop,
              height: scroller.scrollHeight - co, width: scroller.scrollWidth - co,
              clientHeight: scroller.clientHeight - co, clientWidth: scroller.clientWidth - co};
    },

    scrollIntoView: methodOp(function(range, margin) {
      if (range == null) {
        range = {from: this.doc.sel.primary().head, to: null};
        if (margin == null) margin = this.options.cursorScrollMargin;
      } else if (typeof range == "number") {
        range = {from: Pos(range, 0), to: null};
      } else if (range.from == null) {
        range = {from: range, to: null};
      }
      if (!range.to) range.to = range.from;
      range.margin = margin || 0;

      if (range.from.line != null) {
        resolveScrollToPos(this);
        this.curOp.scrollToPos = range;
      } else {
        var sPos = calculateScrollPos(this, Math.min(range.from.left, range.to.left),
                                      Math.min(range.from.top, range.to.top) - range.margin,
                                      Math.max(range.from.right, range.to.right),
                                      Math.max(range.from.bottom, range.to.bottom) + range.margin);
        this.scrollTo(sPos.scrollLeft, sPos.scrollTop);
      }
    }),

    setSize: methodOp(function(width, height) {
      var cm = this;
      function interpret(val) {
        return typeof val == "number" || /^\d+$/.test(String(val)) ? val + "px" : val;
      }
      if (width != null) cm.display.wrapper.style.width = interpret(width);
      if (height != null) cm.display.wrapper.style.height = interpret(height);
      if (cm.options.lineWrapping) clearLineMeasurementCache(this);
      var lineNo = cm.display.viewFrom;
      cm.doc.iter(lineNo, cm.display.viewTo, function(line) {
        if (line.widgets) for (var i = 0; i < line.widgets.length; i++)
          if (line.widgets[i].noHScroll) { regLineChange(cm, lineNo, "widget"); break; }
        ++lineNo;
      });
      cm.curOp.forceUpdate = true;
      signal(cm, "refresh", this);
    }),

    operation: function(f){return runInOp(this, f);},

    refresh: methodOp(function() {
      var oldHeight = this.display.cachedTextHeight;
      regChange(this);
      this.curOp.forceUpdate = true;
      clearCaches(this);
      this.scrollTo(this.doc.scrollLeft, this.doc.scrollTop);
      updateGutterSpace(this);
      if (oldHeight == null || Math.abs(oldHeight - textHeight(this.display)) > .5)
        estimateLineHeights(this);
      signal(this, "refresh", this);
    }),

    swapDoc: methodOp(function(doc) {
      var old = this.doc;
      old.cm = null;
      attachDoc(this, doc);
      clearCaches(this);
      resetInput(this);
      this.scrollTo(doc.scrollLeft, doc.scrollTop);
      signalLater(this, "swapDoc", this, old);
      return old;
    }),

    getInputField: function(){return this.display.input;},
    getWrapperElement: function(){return this.display.wrapper;},
    getScrollerElement: function(){return this.display.scroller;},
    getGutterElement: function(){return this.display.gutters;}
  };
  eventMixin(CodeMirror);

  // OPTION DEFAULTS

  // The default configuration options.
  var defaults = CodeMirror.defaults = {};
  // Functions to run when options are changed.
  var optionHandlers = CodeMirror.optionHandlers = {};

  function option(name, deflt, handle, notOnInit) {
    CodeMirror.defaults[name] = deflt;
    if (handle) optionHandlers[name] =
      notOnInit ? function(cm, val, old) {if (old != Init) handle(cm, val, old);} : handle;
  }

  // Passed to option handlers when there is no old value.
  var Init = CodeMirror.Init = {toString: function(){return "CodeMirror.Init";}};

  // These two are, on init, called from the constructor because they
  // have to be initialized before the editor can start at all.
  option("value", "", function(cm, val) {
    cm.setValue(val);
  }, true);
  option("mode", null, function(cm, val) {
    cm.doc.modeOption = val;
    loadMode(cm);
  }, true);

  option("indentUnit", 2, loadMode, true);
  option("indentWithTabs", false);
  option("smartIndent", true);
  option("tabSize", 4, function(cm) {
    resetModeState(cm);
    clearCaches(cm);
    regChange(cm);
  }, true);
  option("specialChars", /[\t\u0000-\u0019\u00ad\u200b\u2028\u2029\ufeff]/g, function(cm, val) {
    cm.options.specialChars = new RegExp(val.source + (val.test("\t") ? "" : "|\t"), "g");
    cm.refresh();
  }, true);
  option("specialCharPlaceholder", defaultSpecialCharPlaceholder, function(cm) {cm.refresh();}, true);
  option("electricChars", true);
  option("rtlMoveVisually", !windows);
  option("wholeLineUpdateBefore", true);

  option("theme", "default", function(cm) {
    themeChanged(cm);
    guttersChanged(cm);
  }, true);
  option("keyMap", "default", keyMapChanged);
  option("extraKeys", null);

  option("lineWrapping", false, wrappingChanged, true);
  option("gutters", [], function(cm) {
    setGuttersForLineNumbers(cm.options);
    guttersChanged(cm);
  }, true);
  option("fixedGutter", true, function(cm, val) {
    cm.display.gutters.style.left = val ? compensateForHScroll(cm.display) + "px" : "0";
    cm.refresh();
  }, true);
  option("coverGutterNextToScrollbar", false, updateScrollbars, true);
  option("lineNumbers", false, function(cm) {
    setGuttersForLineNumbers(cm.options);
    guttersChanged(cm);
  }, true);
  option("firstLineNumber", 1, guttersChanged, true);
  option("lineNumberFormatter", function(integer) {return integer;}, guttersChanged, true);
  option("showCursorWhenSelecting", false, updateSelection, true);

  option("resetSelectionOnContextMenu", true);

  option("readOnly", false, function(cm, val) {
    if (val == "nocursor") {
      onBlur(cm);
      cm.display.input.blur();
      cm.display.disabled = true;
    } else {
      cm.display.disabled = false;
      if (!val) resetInput(cm);
    }
  });
  option("disableInput", false, function(cm, val) {if (!val) resetInput(cm);}, true);
  option("dragDrop", true);

  option("cursorBlinkRate", 530);
  option("cursorScrollMargin", 0);
  option("cursorHeight", 1, updateSelection, true);
  option("singleCursorHeightPerLine", true, updateSelection, true);
  option("workTime", 100);
  option("workDelay", 100);
  option("flattenSpans", true, resetModeState, true);
  option("addModeClass", false, resetModeState, true);
  option("pollInterval", 100);
  option("undoDepth", 200, function(cm, val){cm.doc.history.undoDepth = val;});
  option("historyEventDelay", 1250);
  option("viewportMargin", 10, function(cm){cm.refresh();}, true);
  option("maxHighlightLength", 10000, resetModeState, true);
  option("moveInputWithCursor", true, function(cm, val) {
    if (!val) cm.display.inputDiv.style.top = cm.display.inputDiv.style.left = 0;
  });

  option("tabindex", null, function(cm, val) {
    cm.display.input.tabIndex = val || "";
  });
  option("autofocus", null);

  // MODE DEFINITION AND QUERYING

  // Known modes, by name and by MIME
  var modes = CodeMirror.modes = {}, mimeModes = CodeMirror.mimeModes = {};

  // Extra arguments are stored as the mode's dependencies, which is
  // used by (legacy) mechanisms like loadmode.js to automatically
  // load a mode. (Preferred mechanism is the require/define calls.)
  CodeMirror.defineMode = function(name, mode) {
    if (!CodeMirror.defaults.mode && name != "null") CodeMirror.defaults.mode = name;
    if (arguments.length > 2) {
      mode.dependencies = [];
      for (var i = 2; i < arguments.length; ++i) mode.dependencies.push(arguments[i]);
    }
    modes[name] = mode;
  };

  CodeMirror.defineMIME = function(mime, spec) {
    mimeModes[mime] = spec;
  };

  // Given a MIME type, a {name, ...options} config object, or a name
  // string, return a mode config object.
  CodeMirror.resolveMode = function(spec) {
    if (typeof spec == "string" && mimeModes.hasOwnProperty(spec)) {
      spec = mimeModes[spec];
    } else if (spec && typeof spec.name == "string" && mimeModes.hasOwnProperty(spec.name)) {
      var found = mimeModes[spec.name];
      if (typeof found == "string") found = {name: found};
      spec = createObj(found, spec);
      spec.name = found.name;
    } else if (typeof spec == "string" && /^[\w\-]+\/[\w\-]+\+xml$/.test(spec)) {
      return CodeMirror.resolveMode("application/xml");
    }
    if (typeof spec == "string") return {name: spec};
    else return spec || {name: "null"};
  };

  // Given a mode spec (anything that resolveMode accepts), find and
  // initialize an actual mode object.
  CodeMirror.getMode = function(options, spec) {
    var spec = CodeMirror.resolveMode(spec);
    var mfactory = modes[spec.name];
    if (!mfactory) return CodeMirror.getMode(options, "text/plain");
    var modeObj = mfactory(options, spec);
    if (modeExtensions.hasOwnProperty(spec.name)) {
      var exts = modeExtensions[spec.name];
      for (var prop in exts) {
        if (!exts.hasOwnProperty(prop)) continue;
        if (modeObj.hasOwnProperty(prop)) modeObj["_" + prop] = modeObj[prop];
        modeObj[prop] = exts[prop];
      }
    }
    modeObj.name = spec.name;
    if (spec.helperType) modeObj.helperType = spec.helperType;
    if (spec.modeProps) for (var prop in spec.modeProps)
      modeObj[prop] = spec.modeProps[prop];

    return modeObj;
  };

  // Minimal default mode.
  CodeMirror.defineMode("null", function() {
    return {token: function(stream) {stream.skipToEnd();}};
  });
  CodeMirror.defineMIME("text/plain", "null");

  // This can be used to attach properties to mode objects from
  // outside the actual mode definition.
  var modeExtensions = CodeMirror.modeExtensions = {};
  CodeMirror.extendMode = function(mode, properties) {
    var exts = modeExtensions.hasOwnProperty(mode) ? modeExtensions[mode] : (modeExtensions[mode] = {});
    copyObj(properties, exts);
  };

  // EXTENSIONS

  CodeMirror.defineExtension = function(name, func) {
    CodeMirror.prototype[name] = func;
  };
  CodeMirror.defineDocExtension = function(name, func) {
    Doc.prototype[name] = func;
  };
  CodeMirror.defineOption = option;

  var initHooks = [];
  CodeMirror.defineInitHook = function(f) {initHooks.push(f);};

  var helpers = CodeMirror.helpers = {};
  CodeMirror.registerHelper = function(type, name, value) {
    if (!helpers.hasOwnProperty(type)) helpers[type] = CodeMirror[type] = {_global: []};
    helpers[type][name] = value;
  };
  CodeMirror.registerGlobalHelper = function(type, name, predicate, value) {
    CodeMirror.registerHelper(type, name, value);
    helpers[type]._global.push({pred: predicate, val: value});
  };

  // MODE STATE HANDLING

  // Utility functions for working with state. Exported because nested
  // modes need to do this for their inner modes.

  var copyState = CodeMirror.copyState = function(mode, state) {
    if (state === true) return state;
    if (mode.copyState) return mode.copyState(state);
    var nstate = {};
    for (var n in state) {
      var val = state[n];
      if (val instanceof Array) val = val.concat([]);
      nstate[n] = val;
    }
    return nstate;
  };

  var startState = CodeMirror.startState = function(mode, a1, a2) {
    return mode.startState ? mode.startState(a1, a2) : true;
  };

  // Given a mode and a state (for that mode), find the inner mode and
  // state at the position that the state refers to.
  CodeMirror.innerMode = function(mode, state) {
    while (mode.innerMode) {
      var info = mode.innerMode(state);
      if (!info || info.mode == mode) break;
      state = info.state;
      mode = info.mode;
    }
    return info || {mode: mode, state: state};
  };

  // STANDARD COMMANDS

  // Commands are parameter-less actions that can be performed on an
  // editor, mostly used for keybindings.
  var commands = CodeMirror.commands = {
    selectAll: function(cm) {cm.setSelection(Pos(cm.firstLine(), 0), Pos(cm.lastLine()), sel_dontScroll);},
    singleSelection: function(cm) {
      cm.setSelection(cm.getCursor("anchor"), cm.getCursor("head"), sel_dontScroll);
    },
    killLine: function(cm) {
      deleteNearSelection(cm, function(range) {
        if (range.empty()) {
          var len = getLine(cm.doc, range.head.line).text.length;
          if (range.head.ch == len && range.head.line < cm.lastLine())
            return {from: range.head, to: Pos(range.head.line + 1, 0)};
          else
            return {from: range.head, to: Pos(range.head.line, len)};
        } else {
          return {from: range.from(), to: range.to()};
        }
      });
    },
    deleteLine: function(cm) {
      deleteNearSelection(cm, function(range) {
        return {from: Pos(range.from().line, 0),
                to: clipPos(cm.doc, Pos(range.to().line + 1, 0))};
      });
    },
    delLineLeft: function(cm) {
      deleteNearSelection(cm, function(range) {
        return {from: Pos(range.from().line, 0), to: range.from()};
      });
    },
    delWrappedLineLeft: function(cm) {
      deleteNearSelection(cm, function(range) {
        var top = cm.charCoords(range.head, "div").top + 5;
        var leftPos = cm.coordsChar({left: 0, top: top}, "div");
        return {from: leftPos, to: range.from()};
      });
    },
    delWrappedLineRight: function(cm) {
      deleteNearSelection(cm, function(range) {
        var top = cm.charCoords(range.head, "div").top + 5;
        var rightPos = cm.coordsChar({left: cm.display.lineDiv.offsetWidth + 100, top: top}, "div");
        return {from: range.from(), to: rightPos };
      });
    },
    undo: function(cm) {cm.undo();},
    redo: function(cm) {cm.redo();},
    undoSelection: function(cm) {cm.undoSelection();},
    redoSelection: function(cm) {cm.redoSelection();},
    goDocStart: function(cm) {cm.extendSelection(Pos(cm.firstLine(), 0));},
    goDocEnd: function(cm) {cm.extendSelection(Pos(cm.lastLine()));},
    goLineStart: function(cm) {
      cm.extendSelectionsBy(function(range) { return lineStart(cm, range.head.line); },
                            {origin: "+move", bias: 1});
    },
    goLineStartSmart: function(cm) {
      cm.extendSelectionsBy(function(range) {
        var start = lineStart(cm, range.head.line);
        var line = cm.getLineHandle(start.line);
        var order = getOrder(line);
        if (!order || order[0].level == 0) {
          var firstNonWS = Math.max(0, line.text.search(/\S/));
          var inWS = range.head.line == start.line && range.head.ch <= firstNonWS && range.head.ch;
          return Pos(start.line, inWS ? 0 : firstNonWS);
        }
        return start;
      }, {origin: "+move", bias: 1});
    },
    goLineEnd: function(cm) {
      cm.extendSelectionsBy(function(range) { return lineEnd(cm, range.head.line); },
                            {origin: "+move", bias: -1});
    },
    goLineRight: function(cm) {
      cm.extendSelectionsBy(function(range) {
        var top = cm.charCoords(range.head, "div").top + 5;
        return cm.coordsChar({left: cm.display.lineDiv.offsetWidth + 100, top: top}, "div");
      }, sel_move);
    },
    goLineLeft: function(cm) {
      cm.extendSelectionsBy(function(range) {
        var top = cm.charCoords(range.head, "div").top + 5;
        return cm.coordsChar({left: 0, top: top}, "div");
      }, sel_move);
    },
    goLineUp: function(cm) {cm.moveV(-1, "line");},
    goLineDown: function(cm) {cm.moveV(1, "line");},
    goPageUp: function(cm) {cm.moveV(-1, "page");},
    goPageDown: function(cm) {cm.moveV(1, "page");},
    goCharLeft: function(cm) {cm.moveH(-1, "char");},
    goCharRight: function(cm) {cm.moveH(1, "char");},
    goColumnLeft: function(cm) {cm.moveH(-1, "column");},
    goColumnRight: function(cm) {cm.moveH(1, "column");},
    goWordLeft: function(cm) {cm.moveH(-1, "word");},
    goGroupRight: function(cm) {cm.moveH(1, "group");},
    goGroupLeft: function(cm) {cm.moveH(-1, "group");},
    goWordRight: function(cm) {cm.moveH(1, "word");},
    delCharBefore: function(cm) {cm.deleteH(-1, "char");},
    delCharAfter: function(cm) {cm.deleteH(1, "char");},
    delWordBefore: function(cm) {cm.deleteH(-1, "word");},
    delWordAfter: function(cm) {cm.deleteH(1, "word");},
    delGroupBefore: function(cm) {cm.deleteH(-1, "group");},
    delGroupAfter: function(cm) {cm.deleteH(1, "group");},
    indentAuto: function(cm) {cm.indentSelection("smart");},
    indentMore: function(cm) {cm.indentSelection("add");},
    indentLess: function(cm) {cm.indentSelection("subtract");},
    insertTab: function(cm) {cm.replaceSelection("\t");},
    insertSoftTab: function(cm) {
      var spaces = [], ranges = cm.listSelections(), tabSize = cm.options.tabSize;
      for (var i = 0; i < ranges.length; i++) {
        var pos = ranges[i].from();
        var col = countColumn(cm.getLine(pos.line), pos.ch, tabSize);
        spaces.push(new Array(tabSize - col % tabSize + 1).join(" "));
      }
      cm.replaceSelections(spaces);
    },
    defaultTab: function(cm) {
      if (cm.somethingSelected()) cm.indentSelection("add");
      else cm.execCommand("insertTab");
    },
    transposeChars: function(cm) {
      runInOp(cm, function() {
        var ranges = cm.listSelections(), newSel = [];
        for (var i = 0; i < ranges.length; i++) {
          var cur = ranges[i].head, line = getLine(cm.doc, cur.line).text;
          if (line) {
            if (cur.ch == line.length) cur = new Pos(cur.line, cur.ch - 1);
            if (cur.ch > 0) {
              cur = new Pos(cur.line, cur.ch + 1);
              cm.replaceRange(line.charAt(cur.ch - 1) + line.charAt(cur.ch - 2),
                              Pos(cur.line, cur.ch - 2), cur, "+transpose");
            } else if (cur.line > cm.doc.first) {
              var prev = getLine(cm.doc, cur.line - 1).text;
              if (prev)
                cm.replaceRange(line.charAt(0) + "\n" + prev.charAt(prev.length - 1),
                                Pos(cur.line - 1, prev.length - 1), Pos(cur.line, 1), "+transpose");
            }
          }
          newSel.push(new Range(cur, cur));
        }
        cm.setSelections(newSel);
      });
    },
    newlineAndIndent: function(cm) {
      runInOp(cm, function() {
        var len = cm.listSelections().length;
        for (var i = 0; i < len; i++) {
          var range = cm.listSelections()[i];
          cm.replaceRange("\n", range.anchor, range.head, "+input");
          cm.indentLine(range.from().line + 1, null, true);
          ensureCursorVisible(cm);
        }
      });
    },
    toggleOverwrite: function(cm) {cm.toggleOverwrite();}
  };

  // STANDARD KEYMAPS

  var keyMap = CodeMirror.keyMap = {};
  keyMap.basic = {
    "Left": "goCharLeft", "Right": "goCharRight", "Up": "goLineUp", "Down": "goLineDown",
    "End": "goLineEnd", "Home": "goLineStartSmart", "PageUp": "goPageUp", "PageDown": "goPageDown",
    "Delete": "delCharAfter", "Backspace": "delCharBefore", "Shift-Backspace": "delCharBefore",
    "Tab": "defaultTab", "Shift-Tab": "indentAuto",
    "Enter": "newlineAndIndent", "Insert": "toggleOverwrite",
    "Esc": "singleSelection"
  };
  // Note that the save and find-related commands aren't defined by
  // default. User code or addons can define them. Unknown commands
  // are simply ignored.
  keyMap.pcDefault = {
    "Ctrl-A": "selectAll", "Ctrl-D": "deleteLine", "Ctrl-Z": "undo", "Shift-Ctrl-Z": "redo", "Ctrl-Y": "redo",
    "Ctrl-Home": "goDocStart", "Ctrl-Up": "goDocStart", "Ctrl-End": "goDocEnd", "Ctrl-Down": "goDocEnd",
    "Ctrl-Left": "goGroupLeft", "Ctrl-Right": "goGroupRight", "Alt-Left": "goLineStart", "Alt-Right": "goLineEnd",
    "Ctrl-Backspace": "delGroupBefore", "Ctrl-Delete": "delGroupAfter", "Ctrl-S": "save", "Ctrl-F": "find",
    "Ctrl-G": "findNext", "Shift-Ctrl-G": "findPrev", "Shift-Ctrl-F": "replace", "Shift-Ctrl-R": "replaceAll",
    "Ctrl-[": "indentLess", "Ctrl-]": "indentMore",
    "Ctrl-U": "undoSelection", "Shift-Ctrl-U": "redoSelection", "Alt-U": "redoSelection",
    fallthrough: "basic"
  };
  keyMap.macDefault = {
    "Cmd-A": "selectAll", "Cmd-D": "deleteLine", "Cmd-Z": "undo", "Shift-Cmd-Z": "redo", "Cmd-Y": "redo",
    "Cmd-Home": "goDocStart", "Cmd-Up": "goDocStart", "Cmd-End": "goDocEnd", "Cmd-Down": "goDocEnd", "Alt-Left": "goGroupLeft",
    "Alt-Right": "goGroupRight", "Cmd-Left": "goLineLeft", "Cmd-Right": "goLineRight", "Alt-Backspace": "delGroupBefore",
    "Ctrl-Alt-Backspace": "delGroupAfter", "Alt-Delete": "delGroupAfter", "Cmd-S": "save", "Cmd-F": "find",
    "Cmd-G": "findNext", "Shift-Cmd-G": "findPrev", "Cmd-Alt-F": "replace", "Shift-Cmd-Alt-F": "replaceAll",
    "Cmd-[": "indentLess", "Cmd-]": "indentMore", "Cmd-Backspace": "delWrappedLineLeft", "Cmd-Delete": "delWrappedLineRight",
    "Cmd-U": "undoSelection", "Shift-Cmd-U": "redoSelection",
    fallthrough: ["basic", "emacsy"]
  };
  // Very basic readline/emacs-style bindings, which are standard on Mac.
  keyMap.emacsy = {
    "Ctrl-F": "goCharRight", "Ctrl-B": "goCharLeft", "Ctrl-P": "goLineUp", "Ctrl-N": "goLineDown",
    "Alt-F": "goWordRight", "Alt-B": "goWordLeft", "Ctrl-A": "goLineStart", "Ctrl-E": "goLineEnd",
    "Ctrl-V": "goPageDown", "Shift-Ctrl-V": "goPageUp", "Ctrl-D": "delCharAfter", "Ctrl-H": "delCharBefore",
    "Alt-D": "delWordAfter", "Alt-Backspace": "delWordBefore", "Ctrl-K": "killLine", "Ctrl-T": "transposeChars"
  };
  keyMap["default"] = mac ? keyMap.macDefault : keyMap.pcDefault;

  // KEYMAP DISPATCH

  function getKeyMap(val) {
    if (typeof val == "string") return keyMap[val];
    else return val;
  }

  // Given an array of keymaps and a key name, call handle on any
  // bindings found, until that returns a truthy value, at which point
  // we consider the key handled. Implements things like binding a key
  // to false stopping further handling and keymap fallthrough.
  var lookupKey = CodeMirror.lookupKey = function(name, maps, handle) {
    function lookup(map) {
      map = getKeyMap(map);
      var found = map[name];
      if (found === false) return "stop";
      if (found != null && handle(found)) return true;
      if (map.nofallthrough) return "stop";

      var fallthrough = map.fallthrough;
      if (fallthrough == null) return false;
      if (Object.prototype.toString.call(fallthrough) != "[object Array]")
        return lookup(fallthrough);
      for (var i = 0; i < fallthrough.length; ++i) {
        var done = lookup(fallthrough[i]);
        if (done) return done;
      }
      return false;
    }

    for (var i = 0; i < maps.length; ++i) {
      var done = lookup(maps[i]);
      if (done) return done != "stop";
    }
  };

  // Modifier key presses don't count as 'real' key presses for the
  // purpose of keymap fallthrough.
  var isModifierKey = CodeMirror.isModifierKey = function(event) {
    var name = keyNames[event.keyCode];
    return name == "Ctrl" || name == "Alt" || name == "Shift" || name == "Mod";
  };

  // Look up the name of a key as indicated by an event object.
  var keyName = CodeMirror.keyName = function(event, noShift) {
    if (presto && event.keyCode == 34 && event["char"]) return false;
    var name = keyNames[event.keyCode];
    if (name == null || event.altGraphKey) return false;
    if (event.altKey) name = "Alt-" + name;
    if (flipCtrlCmd ? event.metaKey : event.ctrlKey) name = "Ctrl-" + name;
    if (flipCtrlCmd ? event.ctrlKey : event.metaKey) name = "Cmd-" + name;
    if (!noShift && event.shiftKey) name = "Shift-" + name;
    return name;
  };

  // FROMTEXTAREA

  CodeMirror.fromTextArea = function(textarea, options) {
    if (!options) options = {};
    options.value = textarea.value;
    if (!options.tabindex && textarea.tabindex)
      options.tabindex = textarea.tabindex;
    if (!options.placeholder && textarea.placeholder)
      options.placeholder = textarea.placeholder;
    // Set autofocus to true if this textarea is focused, or if it has
    // autofocus and no other element is focused.
    if (options.autofocus == null) {
      var hasFocus = activeElt();
      options.autofocus = hasFocus == textarea ||
        textarea.getAttribute("autofocus") != null && hasFocus == document.body;
    }

    function save() {textarea.value = cm.getValue();}
    if (textarea.form) {
      on(textarea.form, "submit", save);
      // Deplorable hack to make the submit method do the right thing.
      if (!options.leaveSubmitMethodAlone) {
        var form = textarea.form, realSubmit = form.submit;
        try {
          var wrappedSubmit = form.submit = function() {
            save();
            form.submit = realSubmit;
            form.submit();
            form.submit = wrappedSubmit;
          };
        } catch(e) {}
      }
    }

    textarea.style.display = "none";
    var cm = CodeMirror(function(node) {
      textarea.parentNode.insertBefore(node, textarea.nextSibling);
    }, options);
    cm.save = save;
    cm.getTextArea = function() { return textarea; };
    cm.toTextArea = function() {
      save();
      textarea.parentNode.removeChild(cm.getWrapperElement());
      textarea.style.display = "";
      if (textarea.form) {
        off(textarea.form, "submit", save);
        if (typeof textarea.form.submit == "function")
          textarea.form.submit = realSubmit;
      }
    };
    return cm;
  };

  // STRING STREAM

  // Fed to the mode parsers, provides helper functions to make
  // parsers more succinct.

  var StringStream = CodeMirror.StringStream = function(string, tabSize) {
    this.pos = this.start = 0;
    this.string = string;
    this.tabSize = tabSize || 8;
    this.lastColumnPos = this.lastColumnValue = 0;
    this.lineStart = 0;
  };

  StringStream.prototype = {
    eol: function() {return this.pos >= this.string.length;},
    sol: function() {return this.pos == this.lineStart;},
    peek: function() {return this.string.charAt(this.pos) || undefined;},
    next: function() {
      if (this.pos < this.string.length)
        return this.string.charAt(this.pos++);
    },
    eat: function(match) {
      var ch = this.string.charAt(this.pos);
      if (typeof match == "string") var ok = ch == match;
      else var ok = ch && (match.test ? match.test(ch) : match(ch));
      if (ok) {++this.pos; return ch;}
    },
    eatWhile: function(match) {
      var start = this.pos;
      while (this.eat(match)){}
      return this.pos > start;
    },
    eatSpace: function() {
      var start = this.pos;
      while (/[\s\u00a0]/.test(this.string.charAt(this.pos))) ++this.pos;
      return this.pos > start;
    },
    skipToEnd: function() {this.pos = this.string.length;},
    skipTo: function(ch) {
      var found = this.string.indexOf(ch, this.pos);
      if (found > -1) {this.pos = found; return true;}
    },
    backUp: function(n) {this.pos -= n;},
    column: function() {
      if (this.lastColumnPos < this.start) {
        this.lastColumnValue = countColumn(this.string, this.start, this.tabSize, this.lastColumnPos, this.lastColumnValue);
        this.lastColumnPos = this.start;
      }
      return this.lastColumnValue - (this.lineStart ? countColumn(this.string, this.lineStart, this.tabSize) : 0);
    },
    indentation: function() {
      return countColumn(this.string, null, this.tabSize) -
        (this.lineStart ? countColumn(this.string, this.lineStart, this.tabSize) : 0);
    },
    match: function(pattern, consume, caseInsensitive) {
      if (typeof pattern == "string") {
        var cased = function(str) {return caseInsensitive ? str.toLowerCase() : str;};
        var substr = this.string.substr(this.pos, pattern.length);
        if (cased(substr) == cased(pattern)) {
          if (consume !== false) this.pos += pattern.length;
          return true;
        }
      } else {
        var match = this.string.slice(this.pos).match(pattern);
        if (match && match.index > 0) return null;
        if (match && consume !== false) this.pos += match[0].length;
        return match;
      }
    },
    current: function(){return this.string.slice(this.start, this.pos);},
    hideFirstChars: function(n, inner) {
      this.lineStart += n;
      try { return inner(); }
      finally { this.lineStart -= n; }
    }
  };

  // TEXTMARKERS

  // Created with markText and setBookmark methods. A TextMarker is a
  // handle that can be used to clear or find a marked position in the
  // document. Line objects hold arrays (markedSpans) containing
  // {from, to, marker} object pointing to such marker objects, and
  // indicating that such a marker is present on that line. Multiple
  // lines may point to the same marker when it spans across lines.
  // The spans will have null for their from/to properties when the
  // marker continues beyond the start/end of the line. Markers have
  // links back to the lines they currently touch.

  var TextMarker = CodeMirror.TextMarker = function(doc, type) {
    this.lines = [];
    this.type = type;
    this.doc = doc;
  };
  eventMixin(TextMarker);

  // Clear the marker.
  TextMarker.prototype.clear = function() {
    if (this.explicitlyCleared) return;
    var cm = this.doc.cm, withOp = cm && !cm.curOp;
    if (withOp) startOperation(cm);
    if (hasHandler(this, "clear")) {
      var found = this.find();
      if (found) signalLater(this, "clear", found.from, found.to);
    }
    var min = null, max = null;
    for (var i = 0; i < this.lines.length; ++i) {
      var line = this.lines[i];
      var span = getMarkedSpanFor(line.markedSpans, this);
      if (cm && !this.collapsed) regLineChange(cm, lineNo(line), "text");
      else if (cm) {
        if (span.to != null) max = lineNo(line);
        if (span.from != null) min = lineNo(line);
      }
      line.markedSpans = removeMarkedSpan(line.markedSpans, span);
      if (span.from == null && this.collapsed && !lineIsHidden(this.doc, line) && cm)
        updateLineHeight(line, textHeight(cm.display));
    }
    if (cm && this.collapsed && !cm.options.lineWrapping) for (var i = 0; i < this.lines.length; ++i) {
      var visual = visualLine(this.lines[i]), len = lineLength(visual);
      if (len > cm.display.maxLineLength) {
        cm.display.maxLine = visual;
        cm.display.maxLineLength = len;
        cm.display.maxLineChanged = true;
      }
    }

    if (min != null && cm && this.collapsed) regChange(cm, min, max + 1);
    this.lines.length = 0;
    this.explicitlyCleared = true;
    if (this.atomic && this.doc.cantEdit) {
      this.doc.cantEdit = false;
      if (cm) reCheckSelection(cm.doc);
    }
    if (cm) signalLater(cm, "markerCleared", cm, this);
    if (withOp) endOperation(cm);
    if (this.parent) this.parent.clear();
  };

  // Find the position of the marker in the document. Returns a {from,
  // to} object by default. Side can be passed to get a specific side
  // -- 0 (both), -1 (left), or 1 (right). When lineObj is true, the
  // Pos objects returned contain a line object, rather than a line
  // number (used to prevent looking up the same line twice).
  TextMarker.prototype.find = function(side, lineObj) {
    if (side == null && this.type == "bookmark") side = 1;
    var from, to;
    for (var i = 0; i < this.lines.length; ++i) {
      var line = this.lines[i];
      var span = getMarkedSpanFor(line.markedSpans, this);
      if (span.from != null) {
        from = Pos(lineObj ? line : lineNo(line), span.from);
        if (side == -1) return from;
      }
      if (span.to != null) {
        to = Pos(lineObj ? line : lineNo(line), span.to);
        if (side == 1) return to;
      }
    }
    return from && {from: from, to: to};
  };

  // Signals that the marker's widget changed, and surrounding layout
  // should be recomputed.
  TextMarker.prototype.changed = function() {
    var pos = this.find(-1, true), widget = this, cm = this.doc.cm;
    if (!pos || !cm) return;
    runInOp(cm, function() {
      var line = pos.line, lineN = lineNo(pos.line);
      var view = findViewForLine(cm, lineN);
      if (view) {
        clearLineMeasurementCacheFor(view);
        cm.curOp.selectionChanged = cm.curOp.forceUpdate = true;
      }
      cm.curOp.updateMaxLine = true;
      if (!lineIsHidden(widget.doc, line) && widget.height != null) {
        var oldHeight = widget.height;
        widget.height = null;
        var dHeight = widgetHeight(widget) - oldHeight;
        if (dHeight)
          updateLineHeight(line, line.height + dHeight);
      }
    });
  };

  TextMarker.prototype.attachLine = function(line) {
    if (!this.lines.length && this.doc.cm) {
      var op = this.doc.cm.curOp;
      if (!op.maybeHiddenMarkers || indexOf(op.maybeHiddenMarkers, this) == -1)
        (op.maybeUnhiddenMarkers || (op.maybeUnhiddenMarkers = [])).push(this);
    }
    this.lines.push(line);
  };
  TextMarker.prototype.detachLine = function(line) {
    this.lines.splice(indexOf(this.lines, line), 1);
    if (!this.lines.length && this.doc.cm) {
      var op = this.doc.cm.curOp;
      (op.maybeHiddenMarkers || (op.maybeHiddenMarkers = [])).push(this);
    }
  };

  // Collapsed markers have unique ids, in order to be able to order
  // them, which is needed for uniquely determining an outer marker
  // when they overlap (they may nest, but not partially overlap).
  var nextMarkerId = 0;

  // Create a marker, wire it up to the right lines, and
  function markText(doc, from, to, options, type) {
    // Shared markers (across linked documents) are handled separately
    // (markTextShared will call out to this again, once per
    // document).
    if (options && options.shared) return markTextShared(doc, from, to, options, type);
    // Ensure we are in an operation.
    if (doc.cm && !doc.cm.curOp) return operation(doc.cm, markText)(doc, from, to, options, type);

    var marker = new TextMarker(doc, type), diff = cmp(from, to);
    if (options) copyObj(options, marker, false);
    // Don't connect empty markers unless clearWhenEmpty is false
    if (diff > 0 || diff == 0 && marker.clearWhenEmpty !== false)
      return marker;
    if (marker.replacedWith) {
      // Showing up as a widget implies collapsed (widget replaces text)
      marker.collapsed = true;
      marker.widgetNode = elt("span", [marker.replacedWith], "CodeMirror-widget");
      if (!options.handleMouseEvents) marker.widgetNode.ignoreEvents = true;
      if (options.insertLeft) marker.widgetNode.insertLeft = true;
    }
    if (marker.collapsed) {
      if (conflictingCollapsedRange(doc, from.line, from, to, marker) ||
          from.line != to.line && conflictingCollapsedRange(doc, to.line, from, to, marker))
        throw new Error("Inserting collapsed marker partially overlapping an existing one");
      sawCollapsedSpans = true;
    }

    if (marker.addToHistory)
      addChangeToHistory(doc, {from: from, to: to, origin: "markText"}, doc.sel, NaN);

    var curLine = from.line, cm = doc.cm, updateMaxLine;
    doc.iter(curLine, to.line + 1, function(line) {
      if (cm && marker.collapsed && !cm.options.lineWrapping && visualLine(line) == cm.display.maxLine)
        updateMaxLine = true;
      if (marker.collapsed && curLine != from.line) updateLineHeight(line, 0);
      addMarkedSpan(line, new MarkedSpan(marker,
                                         curLine == from.line ? from.ch : null,
                                         curLine == to.line ? to.ch : null));
      ++curLine;
    });
    // lineIsHidden depends on the presence of the spans, so needs a second pass
    if (marker.collapsed) doc.iter(from.line, to.line + 1, function(line) {
      if (lineIsHidden(doc, line)) updateLineHeight(line, 0);
    });

    if (marker.clearOnEnter) on(marker, "beforeCursorEnter", function() { marker.clear(); });

    if (marker.readOnly) {
      sawReadOnlySpans = true;
      if (doc.history.done.length || doc.history.undone.length)
        doc.clearHistory();
    }
    if (marker.collapsed) {
      marker.id = ++nextMarkerId;
      marker.atomic = true;
    }
    if (cm) {
      // Sync editor state
      if (updateMaxLine) cm.curOp.updateMaxLine = true;
      if (marker.collapsed)
        regChange(cm, from.line, to.line + 1);
      else if (marker.className || marker.title || marker.startStyle || marker.endStyle)
        for (var i = from.line; i <= to.line; i++) regLineChange(cm, i, "text");
      if (marker.atomic) reCheckSelection(cm.doc);
      signalLater(cm, "markerAdded", cm, marker);
    }
    return marker;
  }

  // SHARED TEXTMARKERS

  // A shared marker spans multiple linked documents. It is
  // implemented as a meta-marker-object controlling multiple normal
  // markers.
  var SharedTextMarker = CodeMirror.SharedTextMarker = function(markers, primary) {
    this.markers = markers;
    this.primary = primary;
    for (var i = 0; i < markers.length; ++i)
      markers[i].parent = this;
  };
  eventMixin(SharedTextMarker);

  SharedTextMarker.prototype.clear = function() {
    if (this.explicitlyCleared) return;
    this.explicitlyCleared = true;
    for (var i = 0; i < this.markers.length; ++i)
      this.markers[i].clear();
    signalLater(this, "clear");
  };
  SharedTextMarker.prototype.find = function(side, lineObj) {
    return this.primary.find(side, lineObj);
  };

  function markTextShared(doc, from, to, options, type) {
    options = copyObj(options);
    options.shared = false;
    var markers = [markText(doc, from, to, options, type)], primary = markers[0];
    var widget = options.widgetNode;
    linkedDocs(doc, function(doc) {
      if (widget) options.widgetNode = widget.cloneNode(true);
      markers.push(markText(doc, clipPos(doc, from), clipPos(doc, to), options, type));
      for (var i = 0; i < doc.linked.length; ++i)
        if (doc.linked[i].isParent) return;
      primary = lst(markers);
    });
    return new SharedTextMarker(markers, primary);
  }

  function findSharedMarkers(doc) {
    return doc.findMarks(Pos(doc.first, 0), doc.clipPos(Pos(doc.lastLine())),
                         function(m) { return m.parent; });
  }

  function copySharedMarkers(doc, markers) {
    for (var i = 0; i < markers.length; i++) {
      var marker = markers[i], pos = marker.find();
      var mFrom = doc.clipPos(pos.from), mTo = doc.clipPos(pos.to);
      if (cmp(mFrom, mTo)) {
        var subMark = markText(doc, mFrom, mTo, marker.primary, marker.primary.type);
        marker.markers.push(subMark);
        subMark.parent = marker;
      }
    }
  }

  function detachSharedMarkers(markers) {
    for (var i = 0; i < markers.length; i++) {
      var marker = markers[i], linked = [marker.primary.doc];;
      linkedDocs(marker.primary.doc, function(d) { linked.push(d); });
      for (var j = 0; j < marker.markers.length; j++) {
        var subMarker = marker.markers[j];
        if (indexOf(linked, subMarker.doc) == -1) {
          subMarker.parent = null;
          marker.markers.splice(j--, 1);
        }
      }
    }
  }

  // TEXTMARKER SPANS

  function MarkedSpan(marker, from, to) {
    this.marker = marker;
    this.from = from; this.to = to;
  }

  // Search an array of spans for a span matching the given marker.
  function getMarkedSpanFor(spans, marker) {
    if (spans) for (var i = 0; i < spans.length; ++i) {
      var span = spans[i];
      if (span.marker == marker) return span;
    }
  }
  // Remove a span from an array, returning undefined if no spans are
  // left (we don't store arrays for lines without spans).
  function removeMarkedSpan(spans, span) {
    for (var r, i = 0; i < spans.length; ++i)
      if (spans[i] != span) (r || (r = [])).push(spans[i]);
    return r;
  }
  // Add a span to a line.
  function addMarkedSpan(line, span) {
    line.markedSpans = line.markedSpans ? line.markedSpans.concat([span]) : [span];
    span.marker.attachLine(line);
  }

  // Used for the algorithm that adjusts markers for a change in the
  // document. These functions cut an array of spans at a given
  // character position, returning an array of remaining chunks (or
  // undefined if nothing remains).
  function markedSpansBefore(old, startCh, isInsert) {
    if (old) for (var i = 0, nw; i < old.length; ++i) {
      var span = old[i], marker = span.marker;
      var startsBefore = span.from == null || (marker.inclusiveLeft ? span.from <= startCh : span.from < startCh);
      if (startsBefore || span.from == startCh && marker.type == "bookmark" && (!isInsert || !span.marker.insertLeft)) {
        var endsAfter = span.to == null || (marker.inclusiveRight ? span.to >= startCh : span.to > startCh);
        (nw || (nw = [])).push(new MarkedSpan(marker, span.from, endsAfter ? null : span.to));
      }
    }
    return nw;
  }
  function markedSpansAfter(old, endCh, isInsert) {
    if (old) for (var i = 0, nw; i < old.length; ++i) {
      var span = old[i], marker = span.marker;
      var endsAfter = span.to == null || (marker.inclusiveRight ? span.to >= endCh : span.to > endCh);
      if (endsAfter || span.from == endCh && marker.type == "bookmark" && (!isInsert || span.marker.insertLeft)) {
        var startsBefore = span.from == null || (marker.inclusiveLeft ? span.from <= endCh : span.from < endCh);
        (nw || (nw = [])).push(new MarkedSpan(marker, startsBefore ? null : span.from - endCh,
                                              span.to == null ? null : span.to - endCh));
      }
    }
    return nw;
  }

  // Given a change object, compute the new set of marker spans that
  // cover the line in which the change took place. Removes spans
  // entirely within the change, reconnects spans belonging to the
  // same marker that appear on both sides of the change, and cuts off
  // spans partially within the change. Returns an array of span
  // arrays with one element for each line in (after) the change.
  function stretchSpansOverChange(doc, change) {
    var oldFirst = isLine(doc, change.from.line) && getLine(doc, change.from.line).markedSpans;
    var oldLast = isLine(doc, change.to.line) && getLine(doc, change.to.line).markedSpans;
    if (!oldFirst && !oldLast) return null;

    var startCh = change.from.ch, endCh = change.to.ch, isInsert = cmp(change.from, change.to) == 0;
    // Get the spans that 'stick out' on both sides
    var first = markedSpansBefore(oldFirst, startCh, isInsert);
    var last = markedSpansAfter(oldLast, endCh, isInsert);

    // Next, merge those two ends
    var sameLine = change.text.length == 1, offset = lst(change.text).length + (sameLine ? startCh : 0);
    if (first) {
      // Fix up .to properties of first
      for (var i = 0; i < first.length; ++i) {
        var span = first[i];
        if (span.to == null) {
          var found = getMarkedSpanFor(last, span.marker);
          if (!found) span.to = startCh;
          else if (sameLine) span.to = found.to == null ? null : found.to + offset;
        }
      }
    }
    if (last) {
      // Fix up .from in last (or move them into first in case of sameLine)
      for (var i = 0; i < last.length; ++i) {
        var span = last[i];
        if (span.to != null) span.to += offset;
        if (span.from == null) {
          var found = getMarkedSpanFor(first, span.marker);
          if (!found) {
            span.from = offset;
            if (sameLine) (first || (first = [])).push(span);
          }
        } else {
          span.from += offset;
          if (sameLine) (first || (first = [])).push(span);
        }
      }
    }
    // Make sure we didn't create any zero-length spans
    if (first) first = clearEmptySpans(first);
    if (last && last != first) last = clearEmptySpans(last);

    var newMarkers = [first];
    if (!sameLine) {
      // Fill gap with whole-line-spans
      var gap = change.text.length - 2, gapMarkers;
      if (gap > 0 && first)
        for (var i = 0; i < first.length; ++i)
          if (first[i].to == null)
            (gapMarkers || (gapMarkers = [])).push(new MarkedSpan(first[i].marker, null, null));
      for (var i = 0; i < gap; ++i)
        newMarkers.push(gapMarkers);
      newMarkers.push(last);
    }
    return newMarkers;
  }

  // Remove spans that are empty and don't have a clearWhenEmpty
  // option of false.
  function clearEmptySpans(spans) {
    for (var i = 0; i < spans.length; ++i) {
      var span = spans[i];
      if (span.from != null && span.from == span.to && span.marker.clearWhenEmpty !== false)
        spans.splice(i--, 1);
    }
    if (!spans.length) return null;
    return spans;
  }

  // Used for un/re-doing changes from the history. Combines the
  // result of computing the existing spans with the set of spans that
  // existed in the history (so that deleting around a span and then
  // undoing brings back the span).
  function mergeOldSpans(doc, change) {
    var old = getOldSpans(doc, change);
    var stretched = stretchSpansOverChange(doc, change);
    if (!old) return stretched;
    if (!stretched) return old;

    for (var i = 0; i < old.length; ++i) {
      var oldCur = old[i], stretchCur = stretched[i];
      if (oldCur && stretchCur) {
        spans: for (var j = 0; j < stretchCur.length; ++j) {
          var span = stretchCur[j];
          for (var k = 0; k < oldCur.length; ++k)
            if (oldCur[k].marker == span.marker) continue spans;
          oldCur.push(span);
        }
      } else if (stretchCur) {
        old[i] = stretchCur;
      }
    }
    return old;
  }

  // Used to 'clip' out readOnly ranges when making a change.
  function removeReadOnlyRanges(doc, from, to) {
    var markers = null;
    doc.iter(from.line, to.line + 1, function(line) {
      if (line.markedSpans) for (var i = 0; i < line.markedSpans.length; ++i) {
        var mark = line.markedSpans[i].marker;
        if (mark.readOnly && (!markers || indexOf(markers, mark) == -1))
          (markers || (markers = [])).push(mark);
      }
    });
    if (!markers) return null;
    var parts = [{from: from, to: to}];
    for (var i = 0; i < markers.length; ++i) {
      var mk = markers[i], m = mk.find(0);
      for (var j = 0; j < parts.length; ++j) {
        var p = parts[j];
        if (cmp(p.to, m.from) < 0 || cmp(p.from, m.to) > 0) continue;
        var newParts = [j, 1], dfrom = cmp(p.from, m.from), dto = cmp(p.to, m.to);
        if (dfrom < 0 || !mk.inclusiveLeft && !dfrom)
          newParts.push({from: p.from, to: m.from});
        if (dto > 0 || !mk.inclusiveRight && !dto)
          newParts.push({from: m.to, to: p.to});
        parts.splice.apply(parts, newParts);
        j += newParts.length - 1;
      }
    }
    return parts;
  }

  // Connect or disconnect spans from a line.
  function detachMarkedSpans(line) {
    var spans = line.markedSpans;
    if (!spans) return;
    for (var i = 0; i < spans.length; ++i)
      spans[i].marker.detachLine(line);
    line.markedSpans = null;
  }
  function attachMarkedSpans(line, spans) {
    if (!spans) return;
    for (var i = 0; i < spans.length; ++i)
      spans[i].marker.attachLine(line);
    line.markedSpans = spans;
  }

  // Helpers used when computing which overlapping collapsed span
  // counts as the larger one.
  function extraLeft(marker) { return marker.inclusiveLeft ? -1 : 0; }
  function extraRight(marker) { return marker.inclusiveRight ? 1 : 0; }

  // Returns a number indicating which of two overlapping collapsed
  // spans is larger (and thus includes the other). Falls back to
  // comparing ids when the spans cover exactly the same range.
  function compareCollapsedMarkers(a, b) {
    var lenDiff = a.lines.length - b.lines.length;
    if (lenDiff != 0) return lenDiff;
    var aPos = a.find(), bPos = b.find();
    var fromCmp = cmp(aPos.from, bPos.from) || extraLeft(a) - extraLeft(b);
    if (fromCmp) return -fromCmp;
    var toCmp = cmp(aPos.to, bPos.to) || extraRight(a) - extraRight(b);
    if (toCmp) return toCmp;
    return b.id - a.id;
  }

  // Find out whether a line ends or starts in a collapsed span. If
  // so, return the marker for that span.
  function collapsedSpanAtSide(line, start) {
    var sps = sawCollapsedSpans && line.markedSpans, found;
    if (sps) for (var sp, i = 0; i < sps.length; ++i) {
      sp = sps[i];
      if (sp.marker.collapsed && (start ? sp.from : sp.to) == null &&
          (!found || compareCollapsedMarkers(found, sp.marker) < 0))
        found = sp.marker;
    }
    return found;
  }
  function collapsedSpanAtStart(line) { return collapsedSpanAtSide(line, true); }
  function collapsedSpanAtEnd(line) { return collapsedSpanAtSide(line, false); }

  // Test whether there exists a collapsed span that partially
  // overlaps (covers the start or end, but not both) of a new span.
  // Such overlap is not allowed.
  function conflictingCollapsedRange(doc, lineNo, from, to, marker) {
    var line = getLine(doc, lineNo);
    var sps = sawCollapsedSpans && line.markedSpans;
    if (sps) for (var i = 0; i < sps.length; ++i) {
      var sp = sps[i];
      if (!sp.marker.collapsed) continue;
      var found = sp.marker.find(0);
      var fromCmp = cmp(found.from, from) || extraLeft(sp.marker) - extraLeft(marker);
      var toCmp = cmp(found.to, to) || extraRight(sp.marker) - extraRight(marker);
      if (fromCmp >= 0 && toCmp <= 0 || fromCmp <= 0 && toCmp >= 0) continue;
      if (fromCmp <= 0 && (cmp(found.to, from) > 0 || (sp.marker.inclusiveRight && marker.inclusiveLeft)) ||
          fromCmp >= 0 && (cmp(found.from, to) < 0 || (sp.marker.inclusiveLeft && marker.inclusiveRight)))
        return true;
    }
  }

  // A visual line is a line as drawn on the screen. Folding, for
  // example, can cause multiple logical lines to appear on the same
  // visual line. This finds the start of the visual line that the
  // given line is part of (usually that is the line itself).
  function visualLine(line) {
    var merged;
    while (merged = collapsedSpanAtStart(line))
      line = merged.find(-1, true).line;
    return line;
  }

  // Returns an array of logical lines that continue the visual line
  // started by the argument, or undefined if there are no such lines.
  function visualLineContinued(line) {
    var merged, lines;
    while (merged = collapsedSpanAtEnd(line)) {
      line = merged.find(1, true).line;
      (lines || (lines = [])).push(line);
    }
    return lines;
  }

  // Get the line number of the start of the visual line that the
  // given line number is part of.
  function visualLineNo(doc, lineN) {
    var line = getLine(doc, lineN), vis = visualLine(line);
    if (line == vis) return lineN;
    return lineNo(vis);
  }
  // Get the line number of the start of the next visual line after
  // the given line.
  function visualLineEndNo(doc, lineN) {
    if (lineN > doc.lastLine()) return lineN;
    var line = getLine(doc, lineN), merged;
    if (!lineIsHidden(doc, line)) return lineN;
    while (merged = collapsedSpanAtEnd(line))
      line = merged.find(1, true).line;
    return lineNo(line) + 1;
  }

  // Compute whether a line is hidden. Lines count as hidden when they
  // are part of a visual line that starts with another line, or when
  // they are entirely covered by collapsed, non-widget span.
  function lineIsHidden(doc, line) {
    var sps = sawCollapsedSpans && line.markedSpans;
    if (sps) for (var sp, i = 0; i < sps.length; ++i) {
      sp = sps[i];
      if (!sp.marker.collapsed) continue;
      if (sp.from == null) return true;
      if (sp.marker.widgetNode) continue;
      if (sp.from == 0 && sp.marker.inclusiveLeft && lineIsHiddenInner(doc, line, sp))
        return true;
    }
  }
  function lineIsHiddenInner(doc, line, span) {
    if (span.to == null) {
      var end = span.marker.find(1, true);
      return lineIsHiddenInner(doc, end.line, getMarkedSpanFor(end.line.markedSpans, span.marker));
    }
    if (span.marker.inclusiveRight && span.to == line.text.length)
      return true;
    for (var sp, i = 0; i < line.markedSpans.length; ++i) {
      sp = line.markedSpans[i];
      if (sp.marker.collapsed && !sp.marker.widgetNode && sp.from == span.to &&
          (sp.to == null || sp.to != span.from) &&
          (sp.marker.inclusiveLeft || span.marker.inclusiveRight) &&
          lineIsHiddenInner(doc, line, sp)) return true;
    }
  }

  // LINE WIDGETS

  // Line widgets are block elements displayed above or below a line.

  var LineWidget = CodeMirror.LineWidget = function(cm, node, options) {
    if (options) for (var opt in options) if (options.hasOwnProperty(opt))
      this[opt] = options[opt];
    this.cm = cm;
    this.node = node;
  };
  eventMixin(LineWidget);

  function adjustScrollWhenAboveVisible(cm, line, diff) {
    if (heightAtLine(line) < ((cm.curOp && cm.curOp.scrollTop) || cm.doc.scrollTop))
      addToScrollPos(cm, null, diff);
  }

  LineWidget.prototype.clear = function() {
    var cm = this.cm, ws = this.line.widgets, line = this.line, no = lineNo(line);
    if (no == null || !ws) return;
    for (var i = 0; i < ws.length; ++i) if (ws[i] == this) ws.splice(i--, 1);
    if (!ws.length) line.widgets = null;
    var height = widgetHeight(this);
    runInOp(cm, function() {
      adjustScrollWhenAboveVisible(cm, line, -height);
      regLineChange(cm, no, "widget");
      updateLineHeight(line, Math.max(0, line.height - height));
    });
  };
  LineWidget.prototype.changed = function() {
    var oldH = this.height, cm = this.cm, line = this.line;
    this.height = null;
    var diff = widgetHeight(this) - oldH;
    if (!diff) return;
    runInOp(cm, function() {
      cm.curOp.forceUpdate = true;
      adjustScrollWhenAboveVisible(cm, line, diff);
      updateLineHeight(line, line.height + diff);
    });
  };

  function widgetHeight(widget) {
    if (widget.height != null) return widget.height;
    if (!contains(document.body, widget.node)) {
      var parentStyle = "position: relative;";
      if (widget.coverGutter)
        parentStyle += "margin-left: -" + widget.cm.getGutterElement().offsetWidth + "px;";
      removeChildrenAndAdd(widget.cm.display.measure, elt("div", [widget.node], null, parentStyle));
    }
    return widget.height = widget.node.offsetHeight;
  }

  function addLineWidget(cm, handle, node, options) {
    var widget = new LineWidget(cm, node, options);
    if (widget.noHScroll) cm.display.alignWidgets = true;
    changeLine(cm.doc, handle, "widget", function(line) {
      var widgets = line.widgets || (line.widgets = []);
      if (widget.insertAt == null) widgets.push(widget);
      else widgets.splice(Math.min(widgets.length - 1, Math.max(0, widget.insertAt)), 0, widget);
      widget.line = line;
      if (!lineIsHidden(cm.doc, line)) {
        var aboveVisible = heightAtLine(line) < cm.doc.scrollTop;
        updateLineHeight(line, line.height + widgetHeight(widget));
        if (aboveVisible) addToScrollPos(cm, null, widget.height);
        cm.curOp.forceUpdate = true;
      }
      return true;
    });
    return widget;
  }

  // LINE DATA STRUCTURE

  // Line objects. These hold state related to a line, including
  // highlighting info (the styles array).
  var Line = CodeMirror.Line = function(text, markedSpans, estimateHeight) {
    this.text = text;
    attachMarkedSpans(this, markedSpans);
    this.height = estimateHeight ? estimateHeight(this) : 1;
  };
  eventMixin(Line);
  Line.prototype.lineNo = function() { return lineNo(this); };

  // Change the content (text, markers) of a line. Automatically
  // invalidates cached information and tries to re-estimate the
  // line's height.
  function updateLine(line, text, markedSpans, estimateHeight) {
    line.text = text;
    if (line.stateAfter) line.stateAfter = null;
    if (line.styles) line.styles = null;
    if (line.order != null) line.order = null;
    detachMarkedSpans(line);
    attachMarkedSpans(line, markedSpans);
    var estHeight = estimateHeight ? estimateHeight(line) : 1;
    if (estHeight != line.height) updateLineHeight(line, estHeight);
  }

  // Detach a line from the document tree and its markers.
  function cleanUpLine(line) {
    line.parent = null;
    detachMarkedSpans(line);
  }

  function extractLineClasses(type, output) {
    if (type) for (;;) {
      var lineClass = type.match(/(?:^|\s+)line-(background-)?(\S+)/);
      if (!lineClass) break;
      type = type.slice(0, lineClass.index) + type.slice(lineClass.index + lineClass[0].length);
      var prop = lineClass[1] ? "bgClass" : "textClass";
      if (output[prop] == null)
        output[prop] = lineClass[2];
      else if (!(new RegExp("(?:^|\s)" + lineClass[2] + "(?:$|\s)")).test(output[prop]))
        output[prop] += " " + lineClass[2];
    }
    return type;
  }

  function callBlankLine(mode, state) {
    if (mode.blankLine) return mode.blankLine(state);
    if (!mode.innerMode) return;
    var inner = CodeMirror.innerMode(mode, state);
    if (inner.mode.blankLine) return inner.mode.blankLine(inner.state);
  }

  function readToken(mode, stream, state) {
    for (var i = 0; i < 10; i++) {
      var style = mode.token(stream, state);
      if (stream.pos > stream.start) return style;
    }
    throw new Error("Mode " + mode.name + " failed to advance stream.");
  }

  // Run the given mode's parser over a line, calling f for each token.
  function runMode(cm, text, mode, state, f, lineClasses, forceToEnd) {
    var flattenSpans = mode.flattenSpans;
    if (flattenSpans == null) flattenSpans = cm.options.flattenSpans;
    var curStart = 0, curStyle = null;
    var stream = new StringStream(text, cm.options.tabSize), style;
    if (text == "") extractLineClasses(callBlankLine(mode, state), lineClasses);
    while (!stream.eol()) {
      if (stream.pos > cm.options.maxHighlightLength) {
        flattenSpans = false;
        if (forceToEnd) processLine(cm, text, state, stream.pos);
        stream.pos = text.length;
        style = null;
      } else {
        style = extractLineClasses(readToken(mode, stream, state), lineClasses);
      }
      if (cm.options.addModeClass) {
        var mName = CodeMirror.innerMode(mode, state).mode.name;
        if (mName) style = "m-" + (style ? mName + " " + style : mName);
      }
      if (!flattenSpans || curStyle != style) {
        if (curStart < stream.start) f(stream.start, curStyle);
        curStart = stream.start; curStyle = style;
      }
      stream.start = stream.pos;
    }
    while (curStart < stream.pos) {
      // Webkit seems to refuse to render text nodes longer than 57444 characters
      var pos = Math.min(stream.pos, curStart + 50000);
      f(pos, curStyle);
      curStart = pos;
    }
  }

  // Compute a style array (an array starting with a mode generation
  // -- for invalidation -- followed by pairs of end positions and
  // style strings), which is used to highlight the tokens on the
  // line.
  function highlightLine(cm, line, state, forceToEnd) {
    // A styles array always starts with a number identifying the
    // mode/overlays that it is based on (for easy invalidation).
    var st = [cm.state.modeGen], lineClasses = {};
    // Compute the base array of styles
    runMode(cm, line.text, cm.doc.mode, state, function(end, style) {
      st.push(end, style);
    }, lineClasses, forceToEnd);

    // Run overlays, adjust style array.
    for (var o = 0; o < cm.state.overlays.length; ++o) {
      var overlay = cm.state.overlays[o], i = 1, at = 0;
      runMode(cm, line.text, overlay.mode, true, function(end, style) {
        var start = i;
        // Ensure there's a token end at the current position, and that i points at it
        while (at < end) {
          var i_end = st[i];
          if (i_end > end)
            st.splice(i, 1, end, st[i+1], i_end);
          i += 2;
          at = Math.min(end, i_end);
        }
        if (!style) return;
        if (overlay.opaque) {
          st.splice(start, i - start, end, "cm-overlay " + style);
          i = start + 2;
        } else {
          for (; start < i; start += 2) {
            var cur = st[start+1];
            st[start+1] = (cur ? cur + " " : "") + "cm-overlay " + style;
          }
        }
      }, lineClasses);
    }

    return {styles: st, classes: lineClasses.bgClass || lineClasses.textClass ? lineClasses : null};
  }

  function getLineStyles(cm, line) {
    if (!line.styles || line.styles[0] != cm.state.modeGen) {
      var result = highlightLine(cm, line, line.stateAfter = getStateBefore(cm, lineNo(line)));
      line.styles = result.styles;
      if (result.classes) line.styleClasses = result.classes;
      else if (line.styleClasses) line.styleClasses = null;
    }
    return line.styles;
  }

  // Lightweight form of highlight -- proceed over this line and
  // update state, but don't save a style array. Used for lines that
  // aren't currently visible.
  function processLine(cm, text, state, startAt) {
    var mode = cm.doc.mode;
    var stream = new StringStream(text, cm.options.tabSize);
    stream.start = stream.pos = startAt || 0;
    if (text == "") callBlankLine(mode, state);
    while (!stream.eol() && stream.pos <= cm.options.maxHighlightLength) {
      readToken(mode, stream, state);
      stream.start = stream.pos;
    }
  }

  // Convert a style as returned by a mode (either null, or a string
  // containing one or more styles) to a CSS style. This is cached,
  // and also looks for line-wide styles.
  var styleToClassCache = {}, styleToClassCacheWithMode = {};
  function interpretTokenStyle(style, options) {
    if (!style || /^\s*$/.test(style)) return null;
    var cache = options.addModeClass ? styleToClassCacheWithMode : styleToClassCache;
    return cache[style] ||
      (cache[style] = style.replace(/\S+/g, "cm-$&"));
  }

  // Render the DOM representation of the text of a line. Also builds
  // up a 'line map', which points at the DOM nodes that represent
  // specific stretches of text, and is used by the measuring code.
  // The returned object contains the DOM node, this map, and
  // information about line-wide styles that were set by the mode.
  function buildLineContent(cm, lineView) {
    // The padding-right forces the element to have a 'border', which
    // is needed on Webkit to be able to get line-level bounding
    // rectangles for it (in measureChar).
    var content = elt("span", null, null, webkit ? "padding-right: .1px" : null);
    var builder = {pre: elt("pre", [content]), content: content, col: 0, pos: 0, cm: cm};
    lineView.measure = {};

    // Iterate over the logical lines that make up this visual line.
    for (var i = 0; i <= (lineView.rest ? lineView.rest.length : 0); i++) {
      var line = i ? lineView.rest[i - 1] : lineView.line, order;
      builder.pos = 0;
      builder.addToken = buildToken;
      // Optionally wire in some hacks into the token-rendering
      // algorithm, to deal with browser quirks.
      if ((ie || webkit) && cm.getOption("lineWrapping"))
        builder.addToken = buildTokenSplitSpaces(builder.addToken);
      if (hasBadBidiRects(cm.display.measure) && (order = getOrder(line)))
        builder.addToken = buildTokenBadBidi(builder.addToken, order);
      builder.map = [];
      insertLineContent(line, builder, getLineStyles(cm, line));
      if (line.styleClasses) {
        if (line.styleClasses.bgClass)
          builder.bgClass = joinClasses(line.styleClasses.bgClass, builder.bgClass || "");
        if (line.styleClasses.textClass)
          builder.textClass = joinClasses(line.styleClasses.textClass, builder.textClass || "");
      }

      // Ensure at least a single node is present, for measuring.
      if (builder.map.length == 0)
        builder.map.push(0, 0, builder.content.appendChild(zeroWidthElement(cm.display.measure)));

      // Store the map and a cache object for the current logical line
      if (i == 0) {
        lineView.measure.map = builder.map;
        lineView.measure.cache = {};
      } else {
        (lineView.measure.maps || (lineView.measure.maps = [])).push(builder.map);
        (lineView.measure.caches || (lineView.measure.caches = [])).push({});
      }
    }

    signal(cm, "renderLine", cm, lineView.line, builder.pre);
    if (builder.pre.className)
      builder.textClass = joinClasses(builder.pre.className, builder.textClass || "");
    return builder;
  }

  function defaultSpecialCharPlaceholder(ch) {
    var token = elt("span", "\u2022", "cm-invalidchar");
    token.title = "\\u" + ch.charCodeAt(0).toString(16);
    return token;
  }

  // Build up the DOM representation for a single token, and add it to
  // the line map. Takes care to render special characters separately.
  function buildToken(builder, text, style, startStyle, endStyle, title) {
    if (!text) return;
    var special = builder.cm.options.specialChars, mustWrap = false;
    if (!special.test(text)) {
      builder.col += text.length;
      var content = document.createTextNode(text);
      builder.map.push(builder.pos, builder.pos + text.length, content);
      if (ie && ie_version < 9) mustWrap = true;
      builder.pos += text.length;
    } else {
      var content = document.createDocumentFragment(), pos = 0;
      while (true) {
        special.lastIndex = pos;
        var m = special.exec(text);
        var skipped = m ? m.index - pos : text.length - pos;
        if (skipped) {
          var txt = document.createTextNode(text.slice(pos, pos + skipped));
          if (ie && ie_version < 9) content.appendChild(elt("span", [txt]));
          else content.appendChild(txt);
          builder.map.push(builder.pos, builder.pos + skipped, txt);
          builder.col += skipped;
          builder.pos += skipped;
        }
        if (!m) break;
        pos += skipped + 1;
        if (m[0] == "\t") {
          var tabSize = builder.cm.options.tabSize, tabWidth = tabSize - builder.col % tabSize;
          var txt = content.appendChild(elt("span", spaceStr(tabWidth), "cm-tab"));
          builder.col += tabWidth;
        } else {
          var txt = builder.cm.options.specialCharPlaceholder(m[0]);
          if (ie && ie_version < 9) content.appendChild(elt("span", [txt]));
          else content.appendChild(txt);
          builder.col += 1;
        }
        builder.map.push(builder.pos, builder.pos + 1, txt);
        builder.pos++;
      }
    }
    if (style || startStyle || endStyle || mustWrap) {
      var fullStyle = style || "";
      if (startStyle) fullStyle += startStyle;
      if (endStyle) fullStyle += endStyle;
      var token = elt("span", [content], fullStyle);
      if (title) token.title = title;
      return builder.content.appendChild(token);
    }
    builder.content.appendChild(content);
  }

  function buildTokenSplitSpaces(inner) {
    function split(old) {
      var out = " ";
      for (var i = 0; i < old.length - 2; ++i) out += i % 2 ? " " : "\u00a0";
      out += " ";
      return out;
    }
    return function(builder, text, style, startStyle, endStyle, title) {
      inner(builder, text.replace(/ {3,}/g, split), style, startStyle, endStyle, title);
    };
  }

  // Work around nonsense dimensions being reported for stretches of
  // right-to-left text.
  function buildTokenBadBidi(inner, order) {
    return function(builder, text, style, startStyle, endStyle, title) {
      style = style ? style + " cm-force-border" : "cm-force-border";
      var start = builder.pos, end = start + text.length;
      for (;;) {
        // Find the part that overlaps with the start of this text
        for (var i = 0; i < order.length; i++) {
          var part = order[i];
          if (part.to > start && part.from <= start) break;
        }
        if (part.to >= end) return inner(builder, text, style, startStyle, endStyle, title);
        inner(builder, text.slice(0, part.to - start), style, startStyle, null, title);
        startStyle = null;
        text = text.slice(part.to - start);
        start = part.to;
      }
    };
  }

  function buildCollapsedSpan(builder, size, marker, ignoreWidget) {
    var widget = !ignoreWidget && marker.widgetNode;
    if (widget) {
      builder.map.push(builder.pos, builder.pos + size, widget);
      builder.content.appendChild(widget);
    }
    builder.pos += size;
  }

  // Outputs a number of spans to make up a line, taking highlighting
  // and marked text into account.
  function insertLineContent(line, builder, styles) {
    var spans = line.markedSpans, allText = line.text, at = 0;
    if (!spans) {
      for (var i = 1; i < styles.length; i+=2)
        builder.addToken(builder, allText.slice(at, at = styles[i]), interpretTokenStyle(styles[i+1], builder.cm.options));
      return;
    }

    var len = allText.length, pos = 0, i = 1, text = "", style;
    var nextChange = 0, spanStyle, spanEndStyle, spanStartStyle, title, collapsed;
    for (;;) {
      if (nextChange == pos) { // Update current marker set
        spanStyle = spanEndStyle = spanStartStyle = title = "";
        collapsed = null; nextChange = Infinity;
        var foundBookmarks = [];
        for (var j = 0; j < spans.length; ++j) {
          var sp = spans[j], m = sp.marker;
          if (sp.from <= pos && (sp.to == null || sp.to > pos)) {
            if (sp.to != null && nextChange > sp.to) { nextChange = sp.to; spanEndStyle = ""; }
            if (m.className) spanStyle += " " + m.className;
            if (m.startStyle && sp.from == pos) spanStartStyle += " " + m.startStyle;
            if (m.endStyle && sp.to == nextChange) spanEndStyle += " " + m.endStyle;
            if (m.title && !title) title = m.title;
            if (m.collapsed && (!collapsed || compareCollapsedMarkers(collapsed.marker, m) < 0))
              collapsed = sp;
          } else if (sp.from > pos && nextChange > sp.from) {
            nextChange = sp.from;
          }
          if (m.type == "bookmark" && sp.from == pos && m.widgetNode) foundBookmarks.push(m);
        }
        if (collapsed && (collapsed.from || 0) == pos) {
          buildCollapsedSpan(builder, (collapsed.to == null ? len + 1 : collapsed.to) - pos,
                             collapsed.marker, collapsed.from == null);
          if (collapsed.to == null) return;
        }
        if (!collapsed && foundBookmarks.length) for (var j = 0; j < foundBookmarks.length; ++j)
          buildCollapsedSpan(builder, 0, foundBookmarks[j]);
      }
      if (pos >= len) break;

      var upto = Math.min(len, nextChange);
      while (true) {
        if (text) {
          var end = pos + text.length;
          if (!collapsed) {
            var tokenText = end > upto ? text.slice(0, upto - pos) : text;
            builder.addToken(builder, tokenText, style ? style + spanStyle : spanStyle,
                             spanStartStyle, pos + tokenText.length == nextChange ? spanEndStyle : "", title);
          }
          if (end >= upto) {text = text.slice(upto - pos); pos = upto; break;}
          pos = end;
          spanStartStyle = "";
        }
        text = allText.slice(at, at = styles[i++]);
        style = interpretTokenStyle(styles[i++], builder.cm.options);
      }
    }
  }

  // DOCUMENT DATA STRUCTURE

  // By default, updates that start and end at the beginning of a line
  // are treated specially, in order to make the association of line
  // widgets and marker elements with the text behave more intuitive.
  function isWholeLineUpdate(doc, change) {
    return change.from.ch == 0 && change.to.ch == 0 && lst(change.text) == "" &&
      (!doc.cm || doc.cm.options.wholeLineUpdateBefore);
  }

  // Perform a change on the document data structure.
  function updateDoc(doc, change, markedSpans, estimateHeight) {
    function spansFor(n) {return markedSpans ? markedSpans[n] : null;}
    function update(line, text, spans) {
      updateLine(line, text, spans, estimateHeight);
      signalLater(line, "change", line, change);
    }

    var from = change.from, to = change.to, text = change.text;
    var firstLine = getLine(doc, from.line), lastLine = getLine(doc, to.line);
    var lastText = lst(text), lastSpans = spansFor(text.length - 1), nlines = to.line - from.line;

    // Adjust the line structure
    if (isWholeLineUpdate(doc, change)) {
      // This is a whole-line replace. Treated specially to make
      // sure line objects move the way they are supposed to.
      for (var i = 0, added = []; i < text.length - 1; ++i)
        added.push(new Line(text[i], spansFor(i), estimateHeight));
      update(lastLine, lastLine.text, lastSpans);
      if (nlines) doc.remove(from.line, nlines);
      if (added.length) doc.insert(from.line, added);
    } else if (firstLine == lastLine) {
      if (text.length == 1) {
        update(firstLine, firstLine.text.slice(0, from.ch) + lastText + firstLine.text.slice(to.ch), lastSpans);
      } else {
        for (var added = [], i = 1; i < text.length - 1; ++i)
          added.push(new Line(text[i], spansFor(i), estimateHeight));
        added.push(new Line(lastText + firstLine.text.slice(to.ch), lastSpans, estimateHeight));
        update(firstLine, firstLine.text.slice(0, from.ch) + text[0], spansFor(0));
        doc.insert(from.line + 1, added);
      }
    } else if (text.length == 1) {
      update(firstLine, firstLine.text.slice(0, from.ch) + text[0] + lastLine.text.slice(to.ch), spansFor(0));
      doc.remove(from.line + 1, nlines);
    } else {
      update(firstLine, firstLine.text.slice(0, from.ch) + text[0], spansFor(0));
      update(lastLine, lastText + lastLine.text.slice(to.ch), lastSpans);
      for (var i = 1, added = []; i < text.length - 1; ++i)
        added.push(new Line(text[i], spansFor(i), estimateHeight));
      if (nlines > 1) doc.remove(from.line + 1, nlines - 1);
      doc.insert(from.line + 1, added);
    }

    signalLater(doc, "change", doc, change);
  }

  // The document is represented as a BTree consisting of leaves, with
  // chunk of lines in them, and branches, with up to ten leaves or
  // other branch nodes below them. The top node is always a branch
  // node, and is the document object itself (meaning it has
  // additional methods and properties).
  //
  // All nodes have parent links. The tree is used both to go from
  // line numbers to line objects, and to go from objects to numbers.
  // It also indexes by height, and is used to convert between height
  // and line object, and to find the total height of the document.
  //
  // See also http://marijnhaverbeke.nl/blog/codemirror-line-tree.html

  function LeafChunk(lines) {
    this.lines = lines;
    this.parent = null;
    for (var i = 0, height = 0; i < lines.length; ++i) {
      lines[i].parent = this;
      height += lines[i].height;
    }
    this.height = height;
  }

  LeafChunk.prototype = {
    chunkSize: function() { return this.lines.length; },
    // Remove the n lines at offset 'at'.
    removeInner: function(at, n) {
      for (var i = at, e = at + n; i < e; ++i) {
        var line = this.lines[i];
        this.height -= line.height;
        cleanUpLine(line);
        signalLater(line, "delete");
      }
      this.lines.splice(at, n);
    },
    // Helper used to collapse a small branch into a single leaf.
    collapse: function(lines) {
      lines.push.apply(lines, this.lines);
    },
    // Insert the given array of lines at offset 'at', count them as
    // having the given height.
    insertInner: function(at, lines, height) {
      this.height += height;
      this.lines = this.lines.slice(0, at).concat(lines).concat(this.lines.slice(at));
      for (var i = 0; i < lines.length; ++i) lines[i].parent = this;
    },
    // Used to iterate over a part of the tree.
    iterN: function(at, n, op) {
      for (var e = at + n; at < e; ++at)
        if (op(this.lines[at])) return true;
    }
  };

  function BranchChunk(children) {
    this.children = children;
    var size = 0, height = 0;
    for (var i = 0; i < children.length; ++i) {
      var ch = children[i];
      size += ch.chunkSize(); height += ch.height;
      ch.parent = this;
    }
    this.size = size;
    this.height = height;
    this.parent = null;
  }

  BranchChunk.prototype = {
    chunkSize: function() { return this.size; },
    removeInner: function(at, n) {
      this.size -= n;
      for (var i = 0; i < this.children.length; ++i) {
        var child = this.children[i], sz = child.chunkSize();
        if (at < sz) {
          var rm = Math.min(n, sz - at), oldHeight = child.height;
          child.removeInner(at, rm);
          this.height -= oldHeight - child.height;
          if (sz == rm) { this.children.splice(i--, 1); child.parent = null; }
          if ((n -= rm) == 0) break;
          at = 0;
        } else at -= sz;
      }
      // If the result is smaller than 25 lines, ensure that it is a
      // single leaf node.
      if (this.size - n < 25 &&
          (this.children.length > 1 || !(this.children[0] instanceof LeafChunk))) {
        var lines = [];
        this.collapse(lines);
        this.children = [new LeafChunk(lines)];
        this.children[0].parent = this;
      }
    },
    collapse: function(lines) {
      for (var i = 0; i < this.children.length; ++i) this.children[i].collapse(lines);
    },
    insertInner: function(at, lines, height) {
      this.size += lines.length;
      this.height += height;
      for (var i = 0; i < this.children.length; ++i) {
        var child = this.children[i], sz = child.chunkSize();
        if (at <= sz) {
          child.insertInner(at, lines, height);
          if (child.lines && child.lines.length > 50) {
            while (child.lines.length > 50) {
              var spilled = child.lines.splice(child.lines.length - 25, 25);
              var newleaf = new LeafChunk(spilled);
              child.height -= newleaf.height;
              this.children.splice(i + 1, 0, newleaf);
              newleaf.parent = this;
            }
            this.maybeSpill();
          }
          break;
        }
        at -= sz;
      }
    },
    // When a node has grown, check whether it should be split.
    maybeSpill: function() {
      if (this.children.length <= 10) return;
      var me = this;
      do {
        var spilled = me.children.splice(me.children.length - 5, 5);
        var sibling = new BranchChunk(spilled);
        if (!me.parent) { // Become the parent node
          var copy = new BranchChunk(me.children);
          copy.parent = me;
          me.children = [copy, sibling];
          me = copy;
        } else {
          me.size -= sibling.size;
          me.height -= sibling.height;
          var myIndex = indexOf(me.parent.children, me);
          me.parent.children.splice(myIndex + 1, 0, sibling);
        }
        sibling.parent = me.parent;
      } while (me.children.length > 10);
      me.parent.maybeSpill();
    },
    iterN: function(at, n, op) {
      for (var i = 0; i < this.children.length; ++i) {
        var child = this.children[i], sz = child.chunkSize();
        if (at < sz) {
          var used = Math.min(n, sz - at);
          if (child.iterN(at, used, op)) return true;
          if ((n -= used) == 0) break;
          at = 0;
        } else at -= sz;
      }
    }
  };

  var nextDocId = 0;
  var Doc = CodeMirror.Doc = function(text, mode, firstLine) {
    if (!(this instanceof Doc)) return new Doc(text, mode, firstLine);
    if (firstLine == null) firstLine = 0;

    BranchChunk.call(this, [new LeafChunk([new Line("", null)])]);
    this.first = firstLine;
    this.scrollTop = this.scrollLeft = 0;
    this.cantEdit = false;
    this.cleanGeneration = 1;
    this.frontier = firstLine;
    var start = Pos(firstLine, 0);
    this.sel = simpleSelection(start);
    this.history = new History(null);
    this.id = ++nextDocId;
    this.modeOption = mode;

    if (typeof text == "string") text = splitLines(text);
    updateDoc(this, {from: start, to: start, text: text});
    setSelection(this, simpleSelection(start), sel_dontScroll);
  };

  Doc.prototype = createObj(BranchChunk.prototype, {
    constructor: Doc,
    // Iterate over the document. Supports two forms -- with only one
    // argument, it calls that for each line in the document. With
    // three, it iterates over the range given by the first two (with
    // the second being non-inclusive).
    iter: function(from, to, op) {
      if (op) this.iterN(from - this.first, to - from, op);
      else this.iterN(this.first, this.first + this.size, from);
    },

    // Non-public interface for adding and removing lines.
    insert: function(at, lines) {
      var height = 0;
      for (var i = 0; i < lines.length; ++i) height += lines[i].height;
      this.insertInner(at - this.first, lines, height);
    },
    remove: function(at, n) { this.removeInner(at - this.first, n); },

    // From here, the methods are part of the public interface. Most
    // are also available from CodeMirror (editor) instances.

    getValue: function(lineSep) {
      var lines = getLines(this, this.first, this.first + this.size);
      if (lineSep === false) return lines;
      return lines.join(lineSep || "\n");
    },
    setValue: docMethodOp(function(code) {
      var top = Pos(this.first, 0), last = this.first + this.size - 1;
      makeChange(this, {from: top, to: Pos(last, getLine(this, last).text.length),
                        text: splitLines(code), origin: "setValue"}, true);
      setSelection(this, simpleSelection(top));
    }),
    replaceRange: function(code, from, to, origin) {
      from = clipPos(this, from);
      to = to ? clipPos(this, to) : from;
      replaceRange(this, code, from, to, origin);
    },
    getRange: function(from, to, lineSep) {
      var lines = getBetween(this, clipPos(this, from), clipPos(this, to));
      if (lineSep === false) return lines;
      return lines.join(lineSep || "\n");
    },

    getLine: function(line) {var l = this.getLineHandle(line); return l && l.text;},

    getLineHandle: function(line) {if (isLine(this, line)) return getLine(this, line);},
    getLineNumber: function(line) {return lineNo(line);},

    getLineHandleVisualStart: function(line) {
      if (typeof line == "number") line = getLine(this, line);
      return visualLine(line);
    },

    lineCount: function() {return this.size;},
    firstLine: function() {return this.first;},
    lastLine: function() {return this.first + this.size - 1;},

    clipPos: function(pos) {return clipPos(this, pos);},

    getCursor: function(start) {
      var range = this.sel.primary(), pos;
      if (start == null || start == "head") pos = range.head;
      else if (start == "anchor") pos = range.anchor;
      else if (start == "end" || start == "to" || start === false) pos = range.to();
      else pos = range.from();
      return pos;
    },
    listSelections: function() { return this.sel.ranges; },
    somethingSelected: function() {return this.sel.somethingSelected();},

    setCursor: docMethodOp(function(line, ch, options) {
      setSimpleSelection(this, clipPos(this, typeof line == "number" ? Pos(line, ch || 0) : line), null, options);
    }),
    setSelection: docMethodOp(function(anchor, head, options) {
      setSimpleSelection(this, clipPos(this, anchor), clipPos(this, head || anchor), options);
    }),
    extendSelection: docMethodOp(function(head, other, options) {
      extendSelection(this, clipPos(this, head), other && clipPos(this, other), options);
    }),
    extendSelections: docMethodOp(function(heads, options) {
      extendSelections(this, clipPosArray(this, heads, options));
    }),
    extendSelectionsBy: docMethodOp(function(f, options) {
      extendSelections(this, map(this.sel.ranges, f), options);
    }),
    setSelections: docMethodOp(function(ranges, primary, options) {
      if (!ranges.length) return;
      for (var i = 0, out = []; i < ranges.length; i++)
        out[i] = new Range(clipPos(this, ranges[i].anchor),
                           clipPos(this, ranges[i].head));
      if (primary == null) primary = Math.min(ranges.length - 1, this.sel.primIndex);
      setSelection(this, normalizeSelection(out, primary), options);
    }),
    addSelection: docMethodOp(function(anchor, head, options) {
      var ranges = this.sel.ranges.slice(0);
      ranges.push(new Range(clipPos(this, anchor), clipPos(this, head || anchor)));
      setSelection(this, normalizeSelection(ranges, ranges.length - 1), options);
    }),

    getSelection: function(lineSep) {
      var ranges = this.sel.ranges, lines;
      for (var i = 0; i < ranges.length; i++) {
        var sel = getBetween(this, ranges[i].from(), ranges[i].to());
        lines = lines ? lines.concat(sel) : sel;
      }
      if (lineSep === false) return lines;
      else return lines.join(lineSep || "\n");
    },
    getSelections: function(lineSep) {
      var parts = [], ranges = this.sel.ranges;
      for (var i = 0; i < ranges.length; i++) {
        var sel = getBetween(this, ranges[i].from(), ranges[i].to());
        if (lineSep !== false) sel = sel.join(lineSep || "\n");
        parts[i] = sel;
      }
      return parts;
    },
    replaceSelection: function(code, collapse, origin) {
      var dup = [];
      for (var i = 0; i < this.sel.ranges.length; i++)
        dup[i] = code;
      this.replaceSelections(dup, collapse, origin || "+input");
    },
    replaceSelections: docMethodOp(function(code, collapse, origin) {
      var changes = [], sel = this.sel;
      for (var i = 0; i < sel.ranges.length; i++) {
        var range = sel.ranges[i];
        changes[i] = {from: range.from(), to: range.to(), text: splitLines(code[i]), origin: origin};
      }
      var newSel = collapse && collapse != "end" && computeReplacedSel(this, changes, collapse);
      for (var i = changes.length - 1; i >= 0; i--)
        makeChange(this, changes[i]);
      if (newSel) setSelectionReplaceHistory(this, newSel);
      else if (this.cm) ensureCursorVisible(this.cm);
    }),
    undo: docMethodOp(function() {makeChangeFromHistory(this, "undo");}),
    redo: docMethodOp(function() {makeChangeFromHistory(this, "redo");}),
    undoSelection: docMethodOp(function() {makeChangeFromHistory(this, "undo", true);}),
    redoSelection: docMethodOp(function() {makeChangeFromHistory(this, "redo", true);}),

    setExtending: function(val) {this.extend = val;},
    getExtending: function() {return this.extend;},

    historySize: function() {
      var hist = this.history, done = 0, undone = 0;
      for (var i = 0; i < hist.done.length; i++) if (!hist.done[i].ranges) ++done;
      for (var i = 0; i < hist.undone.length; i++) if (!hist.undone[i].ranges) ++undone;
      return {undo: done, redo: undone};
    },
    clearHistory: function() {this.history = new History(this.history.maxGeneration);},

    markClean: function() {
      this.cleanGeneration = this.changeGeneration(true);
    },
    changeGeneration: function(forceSplit) {
      if (forceSplit)
        this.history.lastOp = this.history.lastOrigin = null;
      return this.history.generation;
    },
    isClean: function (gen) {
      return this.history.generation == (gen || this.cleanGeneration);
    },

    getHistory: function() {
      return {done: copyHistoryArray(this.history.done),
              undone: copyHistoryArray(this.history.undone)};
    },
    setHistory: function(histData) {
      var hist = this.history = new History(this.history.maxGeneration);
      hist.done = copyHistoryArray(histData.done.slice(0), null, true);
      hist.undone = copyHistoryArray(histData.undone.slice(0), null, true);
    },

    addLineClass: docMethodOp(function(handle, where, cls) {
      return changeLine(this, handle, "class", function(line) {
        var prop = where == "text" ? "textClass" : where == "background" ? "bgClass" : "wrapClass";
        if (!line[prop]) line[prop] = cls;
        else if (new RegExp("(?:^|\\s)" + cls + "(?:$|\\s)").test(line[prop])) return false;
        else line[prop] += " " + cls;
        return true;
      });
    }),
    removeLineClass: docMethodOp(function(handle, where, cls) {
      return changeLine(this, handle, "class", function(line) {
        var prop = where == "text" ? "textClass" : where == "background" ? "bgClass" : "wrapClass";
        var cur = line[prop];
        if (!cur) return false;
        else if (cls == null) line[prop] = null;
        else {
          var found = cur.match(new RegExp("(?:^|\\s+)" + cls + "(?:$|\\s+)"));
          if (!found) return false;
          var end = found.index + found[0].length;
          line[prop] = cur.slice(0, found.index) + (!found.index || end == cur.length ? "" : " ") + cur.slice(end) || null;
        }
        return true;
      });
    }),

    markText: function(from, to, options) {
      return markText(this, clipPos(this, from), clipPos(this, to), options, "range");
    },
    setBookmark: function(pos, options) {
      var realOpts = {replacedWith: options && (options.nodeType == null ? options.widget : options),
                      insertLeft: options && options.insertLeft,
                      clearWhenEmpty: false, shared: options && options.shared};
      pos = clipPos(this, pos);
      return markText(this, pos, pos, realOpts, "bookmark");
    },
    findMarksAt: function(pos) {
      pos = clipPos(this, pos);
      var markers = [], spans = getLine(this, pos.line).markedSpans;
      if (spans) for (var i = 0; i < spans.length; ++i) {
        var span = spans[i];
        if ((span.from == null || span.from <= pos.ch) &&
            (span.to == null || span.to >= pos.ch))
          markers.push(span.marker.parent || span.marker);
      }
      return markers;
    },
    findMarks: function(from, to, filter) {
      from = clipPos(this, from); to = clipPos(this, to);
      var found = [], lineNo = from.line;
      this.iter(from.line, to.line + 1, function(line) {
        var spans = line.markedSpans;
        if (spans) for (var i = 0; i < spans.length; i++) {
          var span = spans[i];
          if (!(lineNo == from.line && from.ch > span.to ||
                span.from == null && lineNo != from.line||
                lineNo == to.line && span.from > to.ch) &&
              (!filter || filter(span.marker)))
            found.push(span.marker.parent || span.marker);
        }
        ++lineNo;
      });
      return found;
    },
    getAllMarks: function() {
      var markers = [];
      this.iter(function(line) {
        var sps = line.markedSpans;
        if (sps) for (var i = 0; i < sps.length; ++i)
          if (sps[i].from != null) markers.push(sps[i].marker);
      });
      return markers;
    },

    posFromIndex: function(off) {
      var ch, lineNo = this.first;
      this.iter(function(line) {
        var sz = line.text.length + 1;
        if (sz > off) { ch = off; return true; }
        off -= sz;
        ++lineNo;
      });
      return clipPos(this, Pos(lineNo, ch));
    },
    indexFromPos: function (coords) {
      coords = clipPos(this, coords);
      var index = coords.ch;
      if (coords.line < this.first || coords.ch < 0) return 0;
      this.iter(this.first, coords.line, function (line) {
        index += line.text.length + 1;
      });
      return index;
    },

    copy: function(copyHistory) {
      var doc = new Doc(getLines(this, this.first, this.first + this.size), this.modeOption, this.first);
      doc.scrollTop = this.scrollTop; doc.scrollLeft = this.scrollLeft;
      doc.sel = this.sel;
      doc.extend = false;
      if (copyHistory) {
        doc.history.undoDepth = this.history.undoDepth;
        doc.setHistory(this.getHistory());
      }
      return doc;
    },

    linkedDoc: function(options) {
      if (!options) options = {};
      var from = this.first, to = this.first + this.size;
      if (options.from != null && options.from > from) from = options.from;
      if (options.to != null && options.to < to) to = options.to;
      var copy = new Doc(getLines(this, from, to), options.mode || this.modeOption, from);
      if (options.sharedHist) copy.history = this.history;
      (this.linked || (this.linked = [])).push({doc: copy, sharedHist: options.sharedHist});
      copy.linked = [{doc: this, isParent: true, sharedHist: options.sharedHist}];
      copySharedMarkers(copy, findSharedMarkers(this));
      return copy;
    },
    unlinkDoc: function(other) {
      if (other instanceof CodeMirror) other = other.doc;
      if (this.linked) for (var i = 0; i < this.linked.length; ++i) {
        var link = this.linked[i];
        if (link.doc != other) continue;
        this.linked.splice(i, 1);
        other.unlinkDoc(this);
        detachSharedMarkers(findSharedMarkers(this));
        break;
      }
      // If the histories were shared, split them again
      if (other.history == this.history) {
        var splitIds = [other.id];
        linkedDocs(other, function(doc) {splitIds.push(doc.id);}, true);
        other.history = new History(null);
        other.history.done = copyHistoryArray(this.history.done, splitIds);
        other.history.undone = copyHistoryArray(this.history.undone, splitIds);
      }
    },
    iterLinkedDocs: function(f) {linkedDocs(this, f);},

    getMode: function() {return this.mode;},
    getEditor: function() {return this.cm;}
  });

  // Public alias.
  Doc.prototype.eachLine = Doc.prototype.iter;

  // Set up methods on CodeMirror's prototype to redirect to the editor's document.
  var dontDelegate = "iter insert remove copy getEditor".split(" ");
  for (var prop in Doc.prototype) if (Doc.prototype.hasOwnProperty(prop) && indexOf(dontDelegate, prop) < 0)
    CodeMirror.prototype[prop] = (function(method) {
      return function() {return method.apply(this.doc, arguments);};
    })(Doc.prototype[prop]);

  eventMixin(Doc);

  // Call f for all linked documents.
  function linkedDocs(doc, f, sharedHistOnly) {
    function propagate(doc, skip, sharedHist) {
      if (doc.linked) for (var i = 0; i < doc.linked.length; ++i) {
        var rel = doc.linked[i];
        if (rel.doc == skip) continue;
        var shared = sharedHist && rel.sharedHist;
        if (sharedHistOnly && !shared) continue;
        f(rel.doc, shared);
        propagate(rel.doc, doc, shared);
      }
    }
    propagate(doc, null, true);
  }

  // Attach a document to an editor.
  function attachDoc(cm, doc) {
    if (doc.cm) throw new Error("This document is already in use.");
    cm.doc = doc;
    doc.cm = cm;
    estimateLineHeights(cm);
    loadMode(cm);
    if (!cm.options.lineWrapping) findMaxLine(cm);
    cm.options.mode = doc.modeOption;
    regChange(cm);
  }

  // LINE UTILITIES

  // Find the line object corresponding to the given line number.
  function getLine(doc, n) {
    n -= doc.first;
    if (n < 0 || n >= doc.size) throw new Error("There is no line " + (n + doc.first) + " in the document.");
    for (var chunk = doc; !chunk.lines;) {
      for (var i = 0;; ++i) {
        var child = chunk.children[i], sz = child.chunkSize();
        if (n < sz) { chunk = child; break; }
        n -= sz;
      }
    }
    return chunk.lines[n];
  }

  // Get the part of a document between two positions, as an array of
  // strings.
  function getBetween(doc, start, end) {
    var out = [], n = start.line;
    doc.iter(start.line, end.line + 1, function(line) {
      var text = line.text;
      if (n == end.line) text = text.slice(0, end.ch);
      if (n == start.line) text = text.slice(start.ch);
      out.push(text);
      ++n;
    });
    return out;
  }
  // Get the lines between from and to, as array of strings.
  function getLines(doc, from, to) {
    var out = [];
    doc.iter(from, to, function(line) { out.push(line.text); });
    return out;
  }

  // Update the height of a line, propagating the height change
  // upwards to parent nodes.
  function updateLineHeight(line, height) {
    var diff = height - line.height;
    if (diff) for (var n = line; n; n = n.parent) n.height += diff;
  }

  // Given a line object, find its line number by walking up through
  // its parent links.
  function lineNo(line) {
    if (line.parent == null) return null;
    var cur = line.parent, no = indexOf(cur.lines, line);
    for (var chunk = cur.parent; chunk; cur = chunk, chunk = chunk.parent) {
      for (var i = 0;; ++i) {
        if (chunk.children[i] == cur) break;
        no += chunk.children[i].chunkSize();
      }
    }
    return no + cur.first;
  }

  // Find the line at the given vertical position, using the height
  // information in the document tree.
  function lineAtHeight(chunk, h) {
    var n = chunk.first;
    outer: do {
      for (var i = 0; i < chunk.children.length; ++i) {
        var child = chunk.children[i], ch = child.height;
        if (h < ch) { chunk = child; continue outer; }
        h -= ch;
        n += child.chunkSize();
      }
      return n;
    } while (!chunk.lines);
    for (var i = 0; i < chunk.lines.length; ++i) {
      var line = chunk.lines[i], lh = line.height;
      if (h < lh) break;
      h -= lh;
    }
    return n + i;
  }


  // Find the height above the given line.
  function heightAtLine(lineObj) {
    lineObj = visualLine(lineObj);

    var h = 0, chunk = lineObj.parent;
    for (var i = 0; i < chunk.lines.length; ++i) {
      var line = chunk.lines[i];
      if (line == lineObj) break;
      else h += line.height;
    }
    for (var p = chunk.parent; p; chunk = p, p = chunk.parent) {
      for (var i = 0; i < p.children.length; ++i) {
        var cur = p.children[i];
        if (cur == chunk) break;
        else h += cur.height;
      }
    }
    return h;
  }

  // Get the bidi ordering for the given line (and cache it). Returns
  // false for lines that are fully left-to-right, and an array of
  // BidiSpan objects otherwise.
  function getOrder(line) {
    var order = line.order;
    if (order == null) order = line.order = bidiOrdering(line.text);
    return order;
  }

  // HISTORY

  function History(startGen) {
    // Arrays of change events and selections. Doing something adds an
    // event to done and clears undo. Undoing moves events from done
    // to undone, redoing moves them in the other direction.
    this.done = []; this.undone = [];
    this.undoDepth = Infinity;
    // Used to track when changes can be merged into a single undo
    // event
    this.lastModTime = this.lastSelTime = 0;
    this.lastOp = null;
    this.lastOrigin = this.lastSelOrigin = null;
    // Used by the isClean() method
    this.generation = this.maxGeneration = startGen || 1;
  }

  // Create a history change event from an updateDoc-style change
  // object.
  function historyChangeFromChange(doc, change) {
    var histChange = {from: copyPos(change.from), to: changeEnd(change), text: getBetween(doc, change.from, change.to)};
    attachLocalSpans(doc, histChange, change.from.line, change.to.line + 1);
    linkedDocs(doc, function(doc) {attachLocalSpans(doc, histChange, change.from.line, change.to.line + 1);}, true);
    return histChange;
  }

  // Pop all selection events off the end of a history array. Stop at
  // a change event.
  function clearSelectionEvents(array) {
    while (array.length) {
      var last = lst(array);
      if (last.ranges) array.pop();
      else break;
    }
  }

  // Find the top change event in the history. Pop off selection
  // events that are in the way.
  function lastChangeEvent(hist, force) {
    if (force) {
      clearSelectionEvents(hist.done);
      return lst(hist.done);
    } else if (hist.done.length && !lst(hist.done).ranges) {
      return lst(hist.done);
    } else if (hist.done.length > 1 && !hist.done[hist.done.length - 2].ranges) {
      hist.done.pop();
      return lst(hist.done);
    }
  }

  // Register a change in the history. Merges changes that are within
  // a single operation, ore are close together with an origin that
  // allows merging (starting with "+") into a single event.
  function addChangeToHistory(doc, change, selAfter, opId) {
    var hist = doc.history;
    hist.undone.length = 0;
    var time = +new Date, cur;

    if ((hist.lastOp == opId ||
         hist.lastOrigin == change.origin && change.origin &&
         ((change.origin.charAt(0) == "+" && doc.cm && hist.lastModTime > time - doc.cm.options.historyEventDelay) ||
          change.origin.charAt(0) == "*")) &&
        (cur = lastChangeEvent(hist, hist.lastOp == opId))) {
      // Merge this change into the last event
      var last = lst(cur.changes);
      if (cmp(change.from, change.to) == 0 && cmp(change.from, last.to) == 0) {
        // Optimized case for simple insertion -- don't want to add
        // new changesets for every character typed
        last.to = changeEnd(change);
      } else {
        // Add new sub-event
        cur.changes.push(historyChangeFromChange(doc, change));
      }
    } else {
      // Can not be merged, start a new event.
      var before = lst(hist.done);
      if (!before || !before.ranges)
        pushSelectionToHistory(doc.sel, hist.done);
      cur = {changes: [historyChangeFromChange(doc, change)],
             generation: hist.generation};
      hist.done.push(cur);
      while (hist.done.length > hist.undoDepth) {
        hist.done.shift();
        if (!hist.done[0].ranges) hist.done.shift();
      }
    }
    hist.done.push(selAfter);
    hist.generation = ++hist.maxGeneration;
    hist.lastModTime = hist.lastSelTime = time;
    hist.lastOp = opId;
    hist.lastOrigin = hist.lastSelOrigin = change.origin;

    if (!last) signal(doc, "historyAdded");
  }

  function selectionEventCanBeMerged(doc, origin, prev, sel) {
    var ch = origin.charAt(0);
    return ch == "*" ||
      ch == "+" &&
      prev.ranges.length == sel.ranges.length &&
      prev.somethingSelected() == sel.somethingSelected() &&
      new Date - doc.history.lastSelTime <= (doc.cm ? doc.cm.options.historyEventDelay : 500);
  }

  // Called whenever the selection changes, sets the new selection as
  // the pending selection in the history, and pushes the old pending
  // selection into the 'done' array when it was significantly
  // different (in number of selected ranges, emptiness, or time).
  function addSelectionToHistory(doc, sel, opId, options) {
    var hist = doc.history, origin = options && options.origin;

    // A new event is started when the previous origin does not match
    // the current, or the origins don't allow matching. Origins
    // starting with * are always merged, those starting with + are
    // merged when similar and close together in time.
    if (opId == hist.lastOp ||
        (origin && hist.lastSelOrigin == origin &&
         (hist.lastModTime == hist.lastSelTime && hist.lastOrigin == origin ||
          selectionEventCanBeMerged(doc, origin, lst(hist.done), sel))))
      hist.done[hist.done.length - 1] = sel;
    else
      pushSelectionToHistory(sel, hist.done);

    hist.lastSelTime = +new Date;
    hist.lastSelOrigin = origin;
    hist.lastOp = opId;
    if (options && options.clearRedo !== false)
      clearSelectionEvents(hist.undone);
  }

  function pushSelectionToHistory(sel, dest) {
    var top = lst(dest);
    if (!(top && top.ranges && top.equals(sel)))
      dest.push(sel);
  }

  // Used to store marked span information in the history.
  function attachLocalSpans(doc, change, from, to) {
    var existing = change["spans_" + doc.id], n = 0;
    doc.iter(Math.max(doc.first, from), Math.min(doc.first + doc.size, to), function(line) {
      if (line.markedSpans)
        (existing || (existing = change["spans_" + doc.id] = {}))[n] = line.markedSpans;
      ++n;
    });
  }

  // When un/re-doing restores text containing marked spans, those
  // that have been explicitly cleared should not be restored.
  function removeClearedSpans(spans) {
    if (!spans) return null;
    for (var i = 0, out; i < spans.length; ++i) {
      if (spans[i].marker.explicitlyCleared) { if (!out) out = spans.slice(0, i); }
      else if (out) out.push(spans[i]);
    }
    return !out ? spans : out.length ? out : null;
  }

  // Retrieve and filter the old marked spans stored in a change event.
  function getOldSpans(doc, change) {
    var found = change["spans_" + doc.id];
    if (!found) return null;
    for (var i = 0, nw = []; i < change.text.length; ++i)
      nw.push(removeClearedSpans(found[i]));
    return nw;
  }

  // Used both to provide a JSON-safe object in .getHistory, and, when
  // detaching a document, to split the history in two
  function copyHistoryArray(events, newGroup, instantiateSel) {
    for (var i = 0, copy = []; i < events.length; ++i) {
      var event = events[i];
      if (event.ranges) {
        copy.push(instantiateSel ? Selection.prototype.deepCopy.call(event) : event);
        continue;
      }
      var changes = event.changes, newChanges = [];
      copy.push({changes: newChanges});
      for (var j = 0; j < changes.length; ++j) {
        var change = changes[j], m;
        newChanges.push({from: change.from, to: change.to, text: change.text});
        if (newGroup) for (var prop in change) if (m = prop.match(/^spans_(\d+)$/)) {
          if (indexOf(newGroup, Number(m[1])) > -1) {
            lst(newChanges)[prop] = change[prop];
            delete change[prop];
          }
        }
      }
    }
    return copy;
  }

  // Rebasing/resetting history to deal with externally-sourced changes

  function rebaseHistSelSingle(pos, from, to, diff) {
    if (to < pos.line) {
      pos.line += diff;
    } else if (from < pos.line) {
      pos.line = from;
      pos.ch = 0;
    }
  }

  // Tries to rebase an array of history events given a change in the
  // document. If the change touches the same lines as the event, the
  // event, and everything 'behind' it, is discarded. If the change is
  // before the event, the event's positions are updated. Uses a
  // copy-on-write scheme for the positions, to avoid having to
  // reallocate them all on every rebase, but also avoid problems with
  // shared position objects being unsafely updated.
  function rebaseHistArray(array, from, to, diff) {
    for (var i = 0; i < array.length; ++i) {
      var sub = array[i], ok = true;
      if (sub.ranges) {
        if (!sub.copied) { sub = array[i] = sub.deepCopy(); sub.copied = true; }
        for (var j = 0; j < sub.ranges.length; j++) {
          rebaseHistSelSingle(sub.ranges[j].anchor, from, to, diff);
          rebaseHistSelSingle(sub.ranges[j].head, from, to, diff);
        }
        continue;
      }
      for (var j = 0; j < sub.changes.length; ++j) {
        var cur = sub.changes[j];
        if (to < cur.from.line) {
          cur.from = Pos(cur.from.line + diff, cur.from.ch);
          cur.to = Pos(cur.to.line + diff, cur.to.ch);
        } else if (from <= cur.to.line) {
          ok = false;
          break;
        }
      }
      if (!ok) {
        array.splice(0, i + 1);
        i = 0;
      }
    }
  }

  function rebaseHist(hist, change) {
    var from = change.from.line, to = change.to.line, diff = change.text.length - (to - from) - 1;
    rebaseHistArray(hist.done, from, to, diff);
    rebaseHistArray(hist.undone, from, to, diff);
  }

  // EVENT UTILITIES

  // Due to the fact that we still support jurassic IE versions, some
  // compatibility wrappers are needed.

  var e_preventDefault = CodeMirror.e_preventDefault = function(e) {
    if (e.preventDefault) e.preventDefault();
    else e.returnValue = false;
  };
  var e_stopPropagation = CodeMirror.e_stopPropagation = function(e) {
    if (e.stopPropagation) e.stopPropagation();
    else e.cancelBubble = true;
  };
  function e_defaultPrevented(e) {
    return e.defaultPrevented != null ? e.defaultPrevented : e.returnValue == false;
  }
  var e_stop = CodeMirror.e_stop = function(e) {e_preventDefault(e); e_stopPropagation(e);};

  function e_target(e) {return e.target || e.srcElement;}
  function e_button(e) {
    var b = e.which;
    if (b == null) {
      if (e.button & 1) b = 1;
      else if (e.button & 2) b = 3;
      else if (e.button & 4) b = 2;
    }
    if (mac && e.ctrlKey && b == 1) b = 3;
    return b;
  }

  // EVENT HANDLING

  // Lightweight event framework. on/off also work on DOM nodes,
  // registering native DOM handlers.

  var on = CodeMirror.on = function(emitter, type, f) {
    if (emitter.addEventListener)
      emitter.addEventListener(type, f, false);
    else if (emitter.attachEvent)
      emitter.attachEvent("on" + type, f);
    else {
      var map = emitter._handlers || (emitter._handlers = {});
      var arr = map[type] || (map[type] = []);
      arr.push(f);
    }
  };

  var off = CodeMirror.off = function(emitter, type, f) {
    if (emitter.removeEventListener)
      emitter.removeEventListener(type, f, false);
    else if (emitter.detachEvent)
      emitter.detachEvent("on" + type, f);
    else {
      var arr = emitter._handlers && emitter._handlers[type];
      if (!arr) return;
      for (var i = 0; i < arr.length; ++i)
        if (arr[i] == f) { arr.splice(i, 1); break; }
    }
  };

  var signal = CodeMirror.signal = function(emitter, type /*, values...*/) {
    var arr = emitter._handlers && emitter._handlers[type];
    if (!arr) return;
    var args = Array.prototype.slice.call(arguments, 2);
    for (var i = 0; i < arr.length; ++i) arr[i].apply(null, args);
  };

  var orphanDelayedCallbacks = null;

  // Often, we want to signal events at a point where we are in the
  // middle of some work, but don't want the handler to start calling
  // other methods on the editor, which might be in an inconsistent
  // state or simply not expect any other events to happen.
  // signalLater looks whether there are any handlers, and schedules
  // them to be executed when the last operation ends, or, if no
  // operation is active, when a timeout fires.
  function signalLater(emitter, type /*, values...*/) {
    var arr = emitter._handlers && emitter._handlers[type];
    if (!arr) return;
    var args = Array.prototype.slice.call(arguments, 2), list;
    if (operationGroup) {
      list = operationGroup.delayedCallbacks;
    } else if (orphanDelayedCallbacks) {
      list = orphanDelayedCallbacks;
    } else {
      list = orphanDelayedCallbacks = [];
      setTimeout(fireOrphanDelayed, 0);
    }
    function bnd(f) {return function(){f.apply(null, args);};};
    for (var i = 0; i < arr.length; ++i)
      list.push(bnd(arr[i]));
  }

  function fireOrphanDelayed() {
    var delayed = orphanDelayedCallbacks;
    orphanDelayedCallbacks = null;
    for (var i = 0; i < delayed.length; ++i) delayed[i]();
  }

  // The DOM events that CodeMirror handles can be overridden by
  // registering a (non-DOM) handler on the editor for the event name,
  // and preventDefault-ing the event in that handler.
  function signalDOMEvent(cm, e, override) {
    signal(cm, override || e.type, cm, e);
    return e_defaultPrevented(e) || e.codemirrorIgnore;
  }

  function signalCursorActivity(cm) {
    var arr = cm._handlers && cm._handlers.cursorActivity;
    if (!arr) return;
    var set = cm.curOp.cursorActivityHandlers || (cm.curOp.cursorActivityHandlers = []);
    for (var i = 0; i < arr.length; ++i) if (indexOf(set, arr[i]) == -1)
      set.push(arr[i]);
  }

  function hasHandler(emitter, type) {
    var arr = emitter._handlers && emitter._handlers[type];
    return arr && arr.length > 0;
  }

  // Add on and off methods to a constructor's prototype, to make
  // registering events on such objects more convenient.
  function eventMixin(ctor) {
    ctor.prototype.on = function(type, f) {on(this, type, f);};
    ctor.prototype.off = function(type, f) {off(this, type, f);};
  }

  // MISC UTILITIES

  // Number of pixels added to scroller and sizer to hide scrollbar
  var scrollerCutOff = 30;

  // Returned or thrown by various protocols to signal 'I'm not
  // handling this'.
  var Pass = CodeMirror.Pass = {toString: function(){return "CodeMirror.Pass";}};

  // Reused option objects for setSelection & friends
  var sel_dontScroll = {scroll: false}, sel_mouse = {origin: "*mouse"}, sel_move = {origin: "+move"};

  function Delayed() {this.id = null;}
  Delayed.prototype.set = function(ms, f) {
    clearTimeout(this.id);
    this.id = setTimeout(f, ms);
  };

  // Counts the column offset in a string, taking tabs into account.
  // Used mostly to find indentation.
  var countColumn = CodeMirror.countColumn = function(string, end, tabSize, startIndex, startValue) {
    if (end == null) {
      end = string.search(/[^\s\u00a0]/);
      if (end == -1) end = string.length;
    }
    for (var i = startIndex || 0, n = startValue || 0;;) {
      var nextTab = string.indexOf("\t", i);
      if (nextTab < 0 || nextTab >= end)
        return n + (end - i);
      n += nextTab - i;
      n += tabSize - (n % tabSize);
      i = nextTab + 1;
    }
  };

  // The inverse of countColumn -- find the offset that corresponds to
  // a particular column.
  function findColumn(string, goal, tabSize) {
    for (var pos = 0, col = 0;;) {
      var nextTab = string.indexOf("\t", pos);
      if (nextTab == -1) nextTab = string.length;
      var skipped = nextTab - pos;
      if (nextTab == string.length || col + skipped >= goal)
        return pos + Math.min(skipped, goal - col);
      col += nextTab - pos;
      col += tabSize - (col % tabSize);
      pos = nextTab + 1;
      if (col >= goal) return pos;
    }
  }

  var spaceStrs = [""];
  function spaceStr(n) {
    while (spaceStrs.length <= n)
      spaceStrs.push(lst(spaceStrs) + " ");
    return spaceStrs[n];
  }

  function lst(arr) { return arr[arr.length-1]; }

  var selectInput = function(node) { node.select(); };
  if (ios) // Mobile Safari apparently has a bug where select() is broken.
    selectInput = function(node) { node.selectionStart = 0; node.selectionEnd = node.value.length; };
  else if (ie) // Suppress mysterious IE10 errors
    selectInput = function(node) { try { node.select(); } catch(_e) {} };

  function indexOf(array, elt) {
    for (var i = 0; i < array.length; ++i)
      if (array[i] == elt) return i;
    return -1;
  }
  if ([].indexOf) indexOf = function(array, elt) { return array.indexOf(elt); };
  function map(array, f) {
    var out = [];
    for (var i = 0; i < array.length; i++) out[i] = f(array[i], i);
    return out;
  }
  if ([].map) map = function(array, f) { return array.map(f); };

  function createObj(base, props) {
    var inst;
    if (Object.create) {
      inst = Object.create(base);
    } else {
      var ctor = function() {};
      ctor.prototype = base;
      inst = new ctor();
    }
    if (props) copyObj(props, inst);
    return inst;
  };

  function copyObj(obj, target, overwrite) {
    if (!target) target = {};
    for (var prop in obj)
      if (obj.hasOwnProperty(prop) && (overwrite !== false || !target.hasOwnProperty(prop)))
        target[prop] = obj[prop];
    return target;
  }

  function bind(f) {
    var args = Array.prototype.slice.call(arguments, 1);
    return function(){return f.apply(null, args);};
  }

  var nonASCIISingleCaseWordChar = /[\u00df\u3040-\u309f\u30a0-\u30ff\u3400-\u4db5\u4e00-\u9fcc\uac00-\ud7af]/;
  var isWordCharBasic = CodeMirror.isWordChar = function(ch) {
    return /\w/.test(ch) || ch > "\x80" &&
      (ch.toUpperCase() != ch.toLowerCase() || nonASCIISingleCaseWordChar.test(ch));
  };
  function isWordChar(ch, helper) {
    if (!helper) return isWordCharBasic(ch);
    if (helper.source.indexOf("\\w") > -1 && isWordCharBasic(ch)) return true;
    return helper.test(ch);
  }

  function isEmpty(obj) {
    for (var n in obj) if (obj.hasOwnProperty(n) && obj[n]) return false;
    return true;
  }

  // Extending unicode characters. A series of a non-extending char +
  // any number of extending chars is treated as a single unit as far
  // as editing and measuring is concerned. This is not fully correct,
  // since some scripts/fonts/browsers also treat other configurations
  // of code points as a group.
  var extendingChars = /[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u0610-\u061a\u064b-\u065e\u0670\u06d6-\u06dc\u06de-\u06e4\u06e7\u06e8\u06ea-\u06ed\u0711\u0730-\u074a\u07a6-\u07b0\u07eb-\u07f3\u0816-\u0819\u081b-\u0823\u0825-\u0827\u0829-\u082d\u0900-\u0902\u093c\u0941-\u0948\u094d\u0951-\u0955\u0962\u0963\u0981\u09bc\u09be\u09c1-\u09c4\u09cd\u09d7\u09e2\u09e3\u0a01\u0a02\u0a3c\u0a41\u0a42\u0a47\u0a48\u0a4b-\u0a4d\u0a51\u0a70\u0a71\u0a75\u0a81\u0a82\u0abc\u0ac1-\u0ac5\u0ac7\u0ac8\u0acd\u0ae2\u0ae3\u0b01\u0b3c\u0b3e\u0b3f\u0b41-\u0b44\u0b4d\u0b56\u0b57\u0b62\u0b63\u0b82\u0bbe\u0bc0\u0bcd\u0bd7\u0c3e-\u0c40\u0c46-\u0c48\u0c4a-\u0c4d\u0c55\u0c56\u0c62\u0c63\u0cbc\u0cbf\u0cc2\u0cc6\u0ccc\u0ccd\u0cd5\u0cd6\u0ce2\u0ce3\u0d3e\u0d41-\u0d44\u0d4d\u0d57\u0d62\u0d63\u0dca\u0dcf\u0dd2-\u0dd4\u0dd6\u0ddf\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\u0eb1\u0eb4-\u0eb9\u0ebb\u0ebc\u0ec8-\u0ecd\u0f18\u0f19\u0f35\u0f37\u0f39\u0f71-\u0f7e\u0f80-\u0f84\u0f86\u0f87\u0f90-\u0f97\u0f99-\u0fbc\u0fc6\u102d-\u1030\u1032-\u1037\u1039\u103a\u103d\u103e\u1058\u1059\u105e-\u1060\u1071-\u1074\u1082\u1085\u1086\u108d\u109d\u135f\u1712-\u1714\u1732-\u1734\u1752\u1753\u1772\u1773\u17b7-\u17bd\u17c6\u17c9-\u17d3\u17dd\u180b-\u180d\u18a9\u1920-\u1922\u1927\u1928\u1932\u1939-\u193b\u1a17\u1a18\u1a56\u1a58-\u1a5e\u1a60\u1a62\u1a65-\u1a6c\u1a73-\u1a7c\u1a7f\u1b00-\u1b03\u1b34\u1b36-\u1b3a\u1b3c\u1b42\u1b6b-\u1b73\u1b80\u1b81\u1ba2-\u1ba5\u1ba8\u1ba9\u1c2c-\u1c33\u1c36\u1c37\u1cd0-\u1cd2\u1cd4-\u1ce0\u1ce2-\u1ce8\u1ced\u1dc0-\u1de6\u1dfd-\u1dff\u200c\u200d\u20d0-\u20f0\u2cef-\u2cf1\u2de0-\u2dff\u302a-\u302f\u3099\u309a\ua66f-\ua672\ua67c\ua67d\ua6f0\ua6f1\ua802\ua806\ua80b\ua825\ua826\ua8c4\ua8e0-\ua8f1\ua926-\ua92d\ua947-\ua951\ua980-\ua982\ua9b3\ua9b6-\ua9b9\ua9bc\uaa29-\uaa2e\uaa31\uaa32\uaa35\uaa36\uaa43\uaa4c\uaab0\uaab2-\uaab4\uaab7\uaab8\uaabe\uaabf\uaac1\uabe5\uabe8\uabed\udc00-\udfff\ufb1e\ufe00-\ufe0f\ufe20-\ufe26\uff9e\uff9f]/;
  function isExtendingChar(ch) { return ch.charCodeAt(0) >= 768 && extendingChars.test(ch); }

  // DOM UTILITIES

  function elt(tag, content, className, style) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (style) e.style.cssText = style;
    if (typeof content == "string") e.appendChild(document.createTextNode(content));
    else if (content) for (var i = 0; i < content.length; ++i) e.appendChild(content[i]);
    return e;
  }

  var range;
  if (document.createRange) range = function(node, start, end) {
    var r = document.createRange();
    r.setEnd(node, end);
    r.setStart(node, start);
    return r;
  };
  else range = function(node, start, end) {
    var r = document.body.createTextRange();
    r.moveToElementText(node.parentNode);
    r.collapse(true);
    r.moveEnd("character", end);
    r.moveStart("character", start);
    return r;
  };

  function removeChildren(e) {
    for (var count = e.childNodes.length; count > 0; --count)
      e.removeChild(e.firstChild);
    return e;
  }

  function removeChildrenAndAdd(parent, e) {
    return removeChildren(parent).appendChild(e);
  }

  function contains(parent, child) {
    if (parent.contains)
      return parent.contains(child);
    while (child = child.parentNode)
      if (child == parent) return true;
  }

  function activeElt() { return document.activeElement; }
  // Older versions of IE throws unspecified error when touching
  // document.activeElement in some cases (during loading, in iframe)
  if (ie && ie_version < 11) activeElt = function() {
    try { return document.activeElement; }
    catch(e) { return document.body; }
  };

  function classTest(cls) { return new RegExp("\\b" + cls + "\\b\\s*"); }
  function rmClass(node, cls) {
    var test = classTest(cls);
    if (test.test(node.className)) node.className = node.className.replace(test, "");
  }
  function addClass(node, cls) {
    if (!classTest(cls).test(node.className)) node.className += " " + cls;
  }
  function joinClasses(a, b) {
    var as = a.split(" ");
    for (var i = 0; i < as.length; i++)
      if (as[i] && !classTest(as[i]).test(b)) b += " " + as[i];
    return b;
  }

  // WINDOW-WIDE EVENTS

  // These must be handled carefully, because naively registering a
  // handler for each editor will cause the editors to never be
  // garbage collected.

  function forEachCodeMirror(f) {
    if (!document.body.getElementsByClassName) return;
    var byClass = document.body.getElementsByClassName("CodeMirror");
    for (var i = 0; i < byClass.length; i++) {
      var cm = byClass[i].CodeMirror;
      if (cm) f(cm);
    }
  }

  var globalsRegistered = false;
  function ensureGlobalHandlers() {
    if (globalsRegistered) return;
    registerGlobalHandlers();
    globalsRegistered = true;
  }
  function registerGlobalHandlers() {
    // When the window resizes, we need to refresh active editors.
    var resizeTimer;
    on(window, "resize", function() {
      if (resizeTimer == null) resizeTimer = setTimeout(function() {
        resizeTimer = null;
        knownScrollbarWidth = null;
        forEachCodeMirror(onResize);
      }, 100);
    });
    // When the window loses focus, we want to show the editor as blurred
    on(window, "blur", function() {
      forEachCodeMirror(onBlur);
    });
  }

  // FEATURE DETECTION

  // Detect drag-and-drop
  var dragAndDrop = function() {
    // There is *some* kind of drag-and-drop support in IE6-8, but I
    // couldn't get it to work yet.
    if (ie && ie_version < 9) return false;
    var div = elt('div');
    return "draggable" in div || "dragDrop" in div;
  }();

  var knownScrollbarWidth;
  function scrollbarWidth(measure) {
    if (knownScrollbarWidth != null) return knownScrollbarWidth;
    var test = elt("div", null, null, "width: 50px; height: 50px; overflow-x: scroll");
    removeChildrenAndAdd(measure, test);
    if (test.offsetWidth)
      knownScrollbarWidth = test.offsetHeight - test.clientHeight;
    return knownScrollbarWidth || 0;
  }

  var zwspSupported;
  function zeroWidthElement(measure) {
    if (zwspSupported == null) {
      var test = elt("span", "\u200b");
      removeChildrenAndAdd(measure, elt("span", [test, document.createTextNode("x")]));
      if (measure.firstChild.offsetHeight != 0)
        zwspSupported = test.offsetWidth <= 1 && test.offsetHeight > 2 && !(ie && ie_version < 8);
    }
    if (zwspSupported) return elt("span", "\u200b");
    else return elt("span", "\u00a0", null, "display: inline-block; width: 1px; margin-right: -1px");
  }

  // Feature-detect IE's crummy client rect reporting for bidi text
  var badBidiRects;
  function hasBadBidiRects(measure) {
    if (badBidiRects != null) return badBidiRects;
    var txt = removeChildrenAndAdd(measure, document.createTextNode("A\u062eA"));
    var r0 = range(txt, 0, 1).getBoundingClientRect();
    if (r0.left == r0.right) return false;
    var r1 = range(txt, 1, 2).getBoundingClientRect();
    return badBidiRects = (r1.right - r0.right < 3);
  }

  // See if "".split is the broken IE version, if so, provide an
  // alternative way to split lines.
  var splitLines = CodeMirror.splitLines = "\n\nb".split(/\n/).length != 3 ? function(string) {
    var pos = 0, result = [], l = string.length;
    while (pos <= l) {
      var nl = string.indexOf("\n", pos);
      if (nl == -1) nl = string.length;
      var line = string.slice(pos, string.charAt(nl - 1) == "\r" ? nl - 1 : nl);
      var rt = line.indexOf("\r");
      if (rt != -1) {
        result.push(line.slice(0, rt));
        pos += rt + 1;
      } else {
        result.push(line);
        pos = nl + 1;
      }
    }
    return result;
  } : function(string){return string.split(/\r\n?|\n/);};

  var hasSelection = window.getSelection ? function(te) {
    try { return te.selectionStart != te.selectionEnd; }
    catch(e) { return false; }
  } : function(te) {
    try {var range = te.ownerDocument.selection.createRange();}
    catch(e) {}
    if (!range || range.parentElement() != te) return false;
    return range.compareEndPoints("StartToEnd", range) != 0;
  };

  var hasCopyEvent = (function() {
    var e = elt("div");
    if ("oncopy" in e) return true;
    e.setAttribute("oncopy", "return;");
    return typeof e.oncopy == "function";
  })();

  var badZoomedRects = null;
  function hasBadZoomedRects(measure) {
    if (badZoomedRects != null) return badZoomedRects;
    var node = removeChildrenAndAdd(measure, elt("span", "x"));
    var normal = node.getBoundingClientRect();
    var fromRange = range(node, 0, 1).getBoundingClientRect();
    return badZoomedRects = Math.abs(normal.left - fromRange.left) > 1;
  }

  // KEY NAMES

  var keyNames = {3: "Enter", 8: "Backspace", 9: "Tab", 13: "Enter", 16: "Shift", 17: "Ctrl", 18: "Alt",
                  19: "Pause", 20: "CapsLock", 27: "Esc", 32: "Space", 33: "PageUp", 34: "PageDown", 35: "End",
                  36: "Home", 37: "Left", 38: "Up", 39: "Right", 40: "Down", 44: "PrintScrn", 45: "Insert",
                  46: "Delete", 59: ";", 61: "=", 91: "Mod", 92: "Mod", 93: "Mod", 107: "=", 109: "-", 127: "Delete",
                  173: "-", 186: ";", 187: "=", 188: ",", 189: "-", 190: ".", 191: "/", 192: "`", 219: "[", 220: "\\",
                  221: "]", 222: "'", 63232: "Up", 63233: "Down", 63234: "Left", 63235: "Right", 63272: "Delete",
                  63273: "Home", 63275: "End", 63276: "PageUp", 63277: "PageDown", 63302: "Insert"};
  CodeMirror.keyNames = keyNames;
  (function() {
    // Number keys
    for (var i = 0; i < 10; i++) keyNames[i + 48] = keyNames[i + 96] = String(i);
    // Alphabetic keys
    for (var i = 65; i <= 90; i++) keyNames[i] = String.fromCharCode(i);
    // Function keys
    for (var i = 1; i <= 12; i++) keyNames[i + 111] = keyNames[i + 63235] = "F" + i;
  })();

  // BIDI HELPERS

  function iterateBidiSections(order, from, to, f) {
    if (!order) return f(from, to, "ltr");
    var found = false;
    for (var i = 0; i < order.length; ++i) {
      var part = order[i];
      if (part.from < to && part.to > from || from == to && part.to == from) {
        f(Math.max(part.from, from), Math.min(part.to, to), part.level == 1 ? "rtl" : "ltr");
        found = true;
      }
    }
    if (!found) f(from, to, "ltr");
  }

  function bidiLeft(part) { return part.level % 2 ? part.to : part.from; }
  function bidiRight(part) { return part.level % 2 ? part.from : part.to; }

  function lineLeft(line) { var order = getOrder(line); return order ? bidiLeft(order[0]) : 0; }
  function lineRight(line) {
    var order = getOrder(line);
    if (!order) return line.text.length;
    return bidiRight(lst(order));
  }

  function lineStart(cm, lineN) {
    var line = getLine(cm.doc, lineN);
    var visual = visualLine(line);
    if (visual != line) lineN = lineNo(visual);
    var order = getOrder(visual);
    var ch = !order ? 0 : order[0].level % 2 ? lineRight(visual) : lineLeft(visual);
    return Pos(lineN, ch);
  }
  function lineEnd(cm, lineN) {
    var merged, line = getLine(cm.doc, lineN);
    while (merged = collapsedSpanAtEnd(line)) {
      line = merged.find(1, true).line;
      lineN = null;
    }
    var order = getOrder(line);
    var ch = !order ? line.text.length : order[0].level % 2 ? lineLeft(line) : lineRight(line);
    return Pos(lineN == null ? lineNo(line) : lineN, ch);
  }

  function compareBidiLevel(order, a, b) {
    var linedir = order[0].level;
    if (a == linedir) return true;
    if (b == linedir) return false;
    return a < b;
  }
  var bidiOther;
  function getBidiPartAt(order, pos) {
    bidiOther = null;
    for (var i = 0, found; i < order.length; ++i) {
      var cur = order[i];
      if (cur.from < pos && cur.to > pos) return i;
      if ((cur.from == pos || cur.to == pos)) {
        if (found == null) {
          found = i;
        } else if (compareBidiLevel(order, cur.level, order[found].level)) {
          if (cur.from != cur.to) bidiOther = found;
          return i;
        } else {
          if (cur.from != cur.to) bidiOther = i;
          return found;
        }
      }
    }
    return found;
  }

  function moveInLine(line, pos, dir, byUnit) {
    if (!byUnit) return pos + dir;
    do pos += dir;
    while (pos > 0 && isExtendingChar(line.text.charAt(pos)));
    return pos;
  }

  // This is needed in order to move 'visually' through bi-directional
  // text -- i.e., pressing left should make the cursor go left, even
  // when in RTL text. The tricky part is the 'jumps', where RTL and
  // LTR text touch each other. This often requires the cursor offset
  // to move more than one unit, in order to visually move one unit.
  function moveVisually(line, start, dir, byUnit) {
    var bidi = getOrder(line);
    if (!bidi) return moveLogically(line, start, dir, byUnit);
    var pos = getBidiPartAt(bidi, start), part = bidi[pos];
    var target = moveInLine(line, start, part.level % 2 ? -dir : dir, byUnit);

    for (;;) {
      if (target > part.from && target < part.to) return target;
      if (target == part.from || target == part.to) {
        if (getBidiPartAt(bidi, target) == pos) return target;
        part = bidi[pos += dir];
        return (dir > 0) == part.level % 2 ? part.to : part.from;
      } else {
        part = bidi[pos += dir];
        if (!part) return null;
        if ((dir > 0) == part.level % 2)
          target = moveInLine(line, part.to, -1, byUnit);
        else
          target = moveInLine(line, part.from, 1, byUnit);
      }
    }
  }

  function moveLogically(line, start, dir, byUnit) {
    var target = start + dir;
    if (byUnit) while (target > 0 && isExtendingChar(line.text.charAt(target))) target += dir;
    return target < 0 || target > line.text.length ? null : target;
  }

  // Bidirectional ordering algorithm
  // See http://unicode.org/reports/tr9/tr9-13.html for the algorithm
  // that this (partially) implements.

  // One-char codes used for character types:
  // L (L):   Left-to-Right
  // R (R):   Right-to-Left
  // r (AL):  Right-to-Left Arabic
  // 1 (EN):  European Number
  // + (ES):  European Number Separator
  // % (ET):  European Number Terminator
  // n (AN):  Arabic Number
  // , (CS):  Common Number Separator
  // m (NSM): Non-Spacing Mark
  // b (BN):  Boundary Neutral
  // s (B):   Paragraph Separator
  // t (S):   Segment Separator
  // w (WS):  Whitespace
  // N (ON):  Other Neutrals

  // Returns null if characters are ordered as they appear
  // (left-to-right), or an array of sections ({from, to, level}
  // objects) in the order in which they occur visually.
  var bidiOrdering = (function() {
    // Character types for codepoints 0 to 0xff
    var lowTypes = "bbbbbbbbbtstwsbbbbbbbbbbbbbbssstwNN%%%NNNNNN,N,N1111111111NNNNNNNLLLLLLLLLLLLLLLLLLLLLLLLLLNNNNNNLLLLLLLLLLLLLLLLLLLLLLLLLLNNNNbbbbbbsbbbbbbbbbbbbbbbbbbbbbbbbbb,N%%%%NNNNLNNNNN%%11NLNNN1LNNNNNLLLLLLLLLLLLLLLLLLLLLLLNLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLN";
    // Character types for codepoints 0x600 to 0x6ff
    var arabicTypes = "rrrrrrrrrrrr,rNNmmmmmmrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrmmmmmmmmmmmmmmrrrrrrrnnnnnnnnnn%nnrrrmrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrmmmmmmmmmmmmmmmmmmmNmmmm";
    function charType(code) {
      if (code <= 0xf7) return lowTypes.charAt(code);
      else if (0x590 <= code && code <= 0x5f4) return "R";
      else if (0x600 <= code && code <= 0x6ed) return arabicTypes.charAt(code - 0x600);
      else if (0x6ee <= code && code <= 0x8ac) return "r";
      else if (0x2000 <= code && code <= 0x200b) return "w";
      else if (code == 0x200c) return "b";
      else return "L";
    }

    var bidiRE = /[\u0590-\u05f4\u0600-\u06ff\u0700-\u08ac]/;
    var isNeutral = /[stwN]/, isStrong = /[LRr]/, countsAsLeft = /[Lb1n]/, countsAsNum = /[1n]/;
    // Browsers seem to always treat the boundaries of block elements as being L.
    var outerType = "L";

    function BidiSpan(level, from, to) {
      this.level = level;
      this.from = from; this.to = to;
    }

    return function(str) {
      if (!bidiRE.test(str)) return false;
      var len = str.length, types = [];
      for (var i = 0, type; i < len; ++i)
        types.push(type = charType(str.charCodeAt(i)));

      // W1. Examine each non-spacing mark (NSM) in the level run, and
      // change the type of the NSM to the type of the previous
      // character. If the NSM is at the start of the level run, it will
      // get the type of sor.
      for (var i = 0, prev = outerType; i < len; ++i) {
        var type = types[i];
        if (type == "m") types[i] = prev;
        else prev = type;
      }

      // W2. Search backwards from each instance of a European number
      // until the first strong type (R, L, AL, or sor) is found. If an
      // AL is found, change the type of the European number to Arabic
      // number.
      // W3. Change all ALs to R.
      for (var i = 0, cur = outerType; i < len; ++i) {
        var type = types[i];
        if (type == "1" && cur == "r") types[i] = "n";
        else if (isStrong.test(type)) { cur = type; if (type == "r") types[i] = "R"; }
      }

      // W4. A single European separator between two European numbers
      // changes to a European number. A single common separator between
      // two numbers of the same type changes to that type.
      for (var i = 1, prev = types[0]; i < len - 1; ++i) {
        var type = types[i];
        if (type == "+" && prev == "1" && types[i+1] == "1") types[i] = "1";
        else if (type == "," && prev == types[i+1] &&
                 (prev == "1" || prev == "n")) types[i] = prev;
        prev = type;
      }

      // W5. A sequence of European terminators adjacent to European
      // numbers changes to all European numbers.
      // W6. Otherwise, separators and terminators change to Other
      // Neutral.
      for (var i = 0; i < len; ++i) {
        var type = types[i];
        if (type == ",") types[i] = "N";
        else if (type == "%") {
          for (var end = i + 1; end < len && types[end] == "%"; ++end) {}
          var replace = (i && types[i-1] == "!") || (end < len && types[end] == "1") ? "1" : "N";
          for (var j = i; j < end; ++j) types[j] = replace;
          i = end - 1;
        }
      }

      // W7. Search backwards from each instance of a European number
      // until the first strong type (R, L, or sor) is found. If an L is
      // found, then change the type of the European number to L.
      for (var i = 0, cur = outerType; i < len; ++i) {
        var type = types[i];
        if (cur == "L" && type == "1") types[i] = "L";
        else if (isStrong.test(type)) cur = type;
      }

      // N1. A sequence of neutrals takes the direction of the
      // surrounding strong text if the text on both sides has the same
      // direction. European and Arabic numbers act as if they were R in
      // terms of their influence on neutrals. Start-of-level-run (sor)
      // and end-of-level-run (eor) are used at level run boundaries.
      // N2. Any remaining neutrals take the embedding direction.
      for (var i = 0; i < len; ++i) {
        if (isNeutral.test(types[i])) {
          for (var end = i + 1; end < len && isNeutral.test(types[end]); ++end) {}
          var before = (i ? types[i-1] : outerType) == "L";
          var after = (end < len ? types[end] : outerType) == "L";
          var replace = before || after ? "L" : "R";
          for (var j = i; j < end; ++j) types[j] = replace;
          i = end - 1;
        }
      }

      // Here we depart from the documented algorithm, in order to avoid
      // building up an actual levels array. Since there are only three
      // levels (0, 1, 2) in an implementation that doesn't take
      // explicit embedding into account, we can build up the order on
      // the fly, without following the level-based algorithm.
      var order = [], m;
      for (var i = 0; i < len;) {
        if (countsAsLeft.test(types[i])) {
          var start = i;
          for (++i; i < len && countsAsLeft.test(types[i]); ++i) {}
          order.push(new BidiSpan(0, start, i));
        } else {
          var pos = i, at = order.length;
          for (++i; i < len && types[i] != "L"; ++i) {}
          for (var j = pos; j < i;) {
            if (countsAsNum.test(types[j])) {
              if (pos < j) order.splice(at, 0, new BidiSpan(1, pos, j));
              var nstart = j;
              for (++j; j < i && countsAsNum.test(types[j]); ++j) {}
              order.splice(at, 0, new BidiSpan(2, nstart, j));
              pos = j;
            } else ++j;
          }
          if (pos < i) order.splice(at, 0, new BidiSpan(1, pos, i));
        }
      }
      if (order[0].level == 1 && (m = str.match(/^\s+/))) {
        order[0].from = m[0].length;
        order.unshift(new BidiSpan(0, 0, m[0].length));
      }
      if (lst(order).level == 1 && (m = str.match(/\s+$/))) {
        lst(order).to -= m[0].length;
        order.push(new BidiSpan(0, len - m[0].length, len));
      }
      if (order[0].level != lst(order).level)
        order.push(new BidiSpan(order[0].level, len, len));

      return order;
    };
  })();

  // THE END

  CodeMirror.version = "4.4.0";

  return CodeMirror;
});

},{}],2:[function(require,module,exports){
var CodeMirror = require('codemirror');

// MAGIC!
function trimInitialTabs(str) {
  var tabsRe = /(\t*)/;
  var tabsMatches = tabsRe.exec(str);
  var numInitialTabs = 0;
  if(tabsMatches && tabsMatches[1]) {
    numInitialTabs = tabsMatches[1].length;
  }
  var replacementRe = new RegExp('^\t{' + numInitialTabs + '}');
  var lines = str.split('\n').map(function(line) {
    return line.replace(replacementRe, '');
  });
  return lines.join('\n');
}

var execute = (function makeEval() {
  var cheatyEval = eval;
  return function (str) {
    cheatyEval(str);
  };
})();


var proto = Object.create(HTMLElement.prototype);

proto.createdCallback = function() {
  this.cm = null;

  this.addEventListener('keydown', function(e) {
    if(e.metaKey && (e.key === 'e' || e.keyCode === 69)) {
      this.runCode();
      e.preventDefault();
    }
  }, false);
};


proto.attachedCallback = function() {
  var codeSrc;
  
  if(this.attributes.src) {
    codeSrc = this.attributes.src.value;
  }
  
  if(codeSrc === undefined) {
    this.onCodeLoaded('// No src specified');
  } else {
    this.loadCode(codeSrc);
  }

};


proto.loadCode = function(url) {
  var request = new XMLHttpRequest();
  var that = this;
  request.open('get', url, true);
  request.responseType = 'text';
  request.onload = function() {
    that.onCodeLoaded(request.response);
  };
  request.onerror = function() {
    that.onCodeLoaded('// ERROR loading ' + url);
  };
  request.send();
};


proto.onCodeLoaded = function(code) {
  var that = this;
  var ta = document.createElement('textarea');
  this.innerHTML = '';
  this.appendChild(ta);
  
  var codeValue = trimInitialTabs(code).trimRight();
  var cm = CodeMirror(function(el) {
      that.replaceChild(el, ta);
    }, {
      value: codeValue,
      /*lineWrapping: true,
      lineNumbers: true,
      styleActiveLine: true,
      matchBrackets: true,
      showTrailingSpace: true,*/
    }
  );
  this.cm = cm;

  var evt = document.createEvent('CustomEvent');
  evt.initCustomEvent('loaded', false, false, {});
  this.dispatchEvent(evt);

};


proto.runCode = function() {

  if(!this.cm) {
    console.log('nothing to run!');
    return;
  }
  var code = this.cm.getSelection().trim();

  // Ah, but nothing's selected, so we'll find where the cursor is
  // and execute that line only
  if(code.length === 0) {
    var cursor = this.cm.getCursor();
    code = this.cm.getLine(cursor.line);
  }

  execute(code);

};

proto.runAllCode = function() {
  var code = this.cm.getValue();
  execute(code);
};


function XEditor(elementName) {

  document.registerElement(elementName, {
		prototype: proto
	});

}

module.exports = XEditor;


},{"codemirror":1}],3:[function(require,module,exports){
var element = require('./element.js');
element('x-editor');

},{"./element.js":2}]},{},[3])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9Vc2Vycy9zb2xlL2RhdGEveC1lZGl0b3Ivbm9kZV9tb2R1bGVzL2d1bHAtYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvYnJvd3Nlci1wYWNrL19wcmVsdWRlLmpzIiwiL1VzZXJzL3NvbGUvZGF0YS94LWVkaXRvci9ub2RlX21vZHVsZXMvY29kZW1pcnJvci9saWIvY29kZW1pcnJvci5qcyIsIi9Vc2Vycy9zb2xlL2RhdGEveC1lZGl0b3Ivc3JjL2pzL2VsZW1lbnQuanMiLCIvVXNlcnMvc29sZS9kYXRhL3gtZWRpdG9yL3NyYy9qcy9mYWtlXzFkYmM5OGYxLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6blBBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BJQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dGhyb3cgbmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKX12YXIgZj1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwoZi5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxmLGYuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pIiwiLy8gQ29kZU1pcnJvciwgY29weXJpZ2h0IChjKSBieSBNYXJpam4gSGF2ZXJiZWtlIGFuZCBvdGhlcnNcbi8vIERpc3RyaWJ1dGVkIHVuZGVyIGFuIE1JVCBsaWNlbnNlOiBodHRwOi8vY29kZW1pcnJvci5uZXQvTElDRU5TRVxuXG4vLyBUaGlzIGlzIENvZGVNaXJyb3IgKGh0dHA6Ly9jb2RlbWlycm9yLm5ldCksIGEgY29kZSBlZGl0b3Jcbi8vIGltcGxlbWVudGVkIGluIEphdmFTY3JpcHQgb24gdG9wIG9mIHRoZSBicm93c2VyJ3MgRE9NLlxuLy9cbi8vIFlvdSBjYW4gZmluZCBzb21lIHRlY2huaWNhbCBiYWNrZ3JvdW5kIGZvciBzb21lIG9mIHRoZSBjb2RlIGJlbG93XG4vLyBhdCBodHRwOi8vbWFyaWpuaGF2ZXJiZWtlLm5sL2Jsb2cvI2NtLWludGVybmFscyAuXG5cbihmdW5jdGlvbihtb2QpIHtcbiAgaWYgKHR5cGVvZiBleHBvcnRzID09IFwib2JqZWN0XCIgJiYgdHlwZW9mIG1vZHVsZSA9PSBcIm9iamVjdFwiKSAvLyBDb21tb25KU1xuICAgIG1vZHVsZS5leHBvcnRzID0gbW9kKCk7XG4gIGVsc2UgaWYgKHR5cGVvZiBkZWZpbmUgPT0gXCJmdW5jdGlvblwiICYmIGRlZmluZS5hbWQpIC8vIEFNRFxuICAgIHJldHVybiBkZWZpbmUoW10sIG1vZCk7XG4gIGVsc2UgLy8gUGxhaW4gYnJvd3NlciBlbnZcbiAgICB0aGlzLkNvZGVNaXJyb3IgPSBtb2QoKTtcbn0pKGZ1bmN0aW9uKCkge1xuICBcInVzZSBzdHJpY3RcIjtcblxuICAvLyBCUk9XU0VSIFNOSUZGSU5HXG5cbiAgLy8gS2x1ZGdlcyBmb3IgYnVncyBhbmQgYmVoYXZpb3IgZGlmZmVyZW5jZXMgdGhhdCBjYW4ndCBiZSBmZWF0dXJlXG4gIC8vIGRldGVjdGVkIGFyZSBlbmFibGVkIGJhc2VkIG9uIHVzZXJBZ2VudCBldGMgc25pZmZpbmcuXG5cbiAgdmFyIGdlY2tvID0gL2dlY2tvXFwvXFxkL2kudGVzdChuYXZpZ2F0b3IudXNlckFnZW50KTtcbiAgLy8gaWVfdXB0b04gbWVhbnMgSW50ZXJuZXQgRXhwbG9yZXIgdmVyc2lvbiBOIG9yIGxvd2VyXG4gIHZhciBpZV91cHRvMTAgPSAvTVNJRSBcXGQvLnRlc3QobmF2aWdhdG9yLnVzZXJBZ2VudCk7XG4gIHZhciBpZV8xMXVwID0gL1RyaWRlbnRcXC8oPzpbNy05XXxcXGR7Mix9KVxcLi4qcnY6KFxcZCspLy5leGVjKG5hdmlnYXRvci51c2VyQWdlbnQpO1xuICB2YXIgaWUgPSBpZV91cHRvMTAgfHwgaWVfMTF1cDtcbiAgdmFyIGllX3ZlcnNpb24gPSBpZSAmJiAoaWVfdXB0bzEwID8gZG9jdW1lbnQuZG9jdW1lbnRNb2RlIHx8IDYgOiBpZV8xMXVwWzFdKTtcbiAgdmFyIHdlYmtpdCA9IC9XZWJLaXRcXC8vLnRlc3QobmF2aWdhdG9yLnVzZXJBZ2VudCk7XG4gIHZhciBxdHdlYmtpdCA9IHdlYmtpdCAmJiAvUXRcXC9cXGQrXFwuXFxkKy8udGVzdChuYXZpZ2F0b3IudXNlckFnZW50KTtcbiAgdmFyIGNocm9tZSA9IC9DaHJvbWVcXC8vLnRlc3QobmF2aWdhdG9yLnVzZXJBZ2VudCk7XG4gIHZhciBwcmVzdG8gPSAvT3BlcmFcXC8vLnRlc3QobmF2aWdhdG9yLnVzZXJBZ2VudCk7XG4gIHZhciBzYWZhcmkgPSAvQXBwbGUgQ29tcHV0ZXIvLnRlc3QobmF2aWdhdG9yLnZlbmRvcik7XG4gIHZhciBraHRtbCA9IC9LSFRNTFxcLy8udGVzdChuYXZpZ2F0b3IudXNlckFnZW50KTtcbiAgdmFyIG1hY19nZU1vdW50YWluTGlvbiA9IC9NYWMgT1MgWCAxXFxkXFxEKFs4LTldfFxcZFxcZClcXEQvLnRlc3QobmF2aWdhdG9yLnVzZXJBZ2VudCk7XG4gIHZhciBwaGFudG9tID0gL1BoYW50b21KUy8udGVzdChuYXZpZ2F0b3IudXNlckFnZW50KTtcblxuICB2YXIgaW9zID0gL0FwcGxlV2ViS2l0Ly50ZXN0KG5hdmlnYXRvci51c2VyQWdlbnQpICYmIC9Nb2JpbGVcXC9cXHcrLy50ZXN0KG5hdmlnYXRvci51c2VyQWdlbnQpO1xuICAvLyBUaGlzIGlzIHdvZWZ1bGx5IGluY29tcGxldGUuIFN1Z2dlc3Rpb25zIGZvciBhbHRlcm5hdGl2ZSBtZXRob2RzIHdlbGNvbWUuXG4gIHZhciBtb2JpbGUgPSBpb3MgfHwgL0FuZHJvaWR8d2ViT1N8QmxhY2tCZXJyeXxPcGVyYSBNaW5pfE9wZXJhIE1vYml8SUVNb2JpbGUvaS50ZXN0KG5hdmlnYXRvci51c2VyQWdlbnQpO1xuICB2YXIgbWFjID0gaW9zIHx8IC9NYWMvLnRlc3QobmF2aWdhdG9yLnBsYXRmb3JtKTtcbiAgdmFyIHdpbmRvd3MgPSAvd2luL2kudGVzdChuYXZpZ2F0b3IucGxhdGZvcm0pO1xuXG4gIHZhciBwcmVzdG9fdmVyc2lvbiA9IHByZXN0byAmJiBuYXZpZ2F0b3IudXNlckFnZW50Lm1hdGNoKC9WZXJzaW9uXFwvKFxcZCpcXC5cXGQqKS8pO1xuICBpZiAocHJlc3RvX3ZlcnNpb24pIHByZXN0b192ZXJzaW9uID0gTnVtYmVyKHByZXN0b192ZXJzaW9uWzFdKTtcbiAgaWYgKHByZXN0b192ZXJzaW9uICYmIHByZXN0b192ZXJzaW9uID49IDE1KSB7IHByZXN0byA9IGZhbHNlOyB3ZWJraXQgPSB0cnVlOyB9XG4gIC8vIFNvbWUgYnJvd3NlcnMgdXNlIHRoZSB3cm9uZyBldmVudCBwcm9wZXJ0aWVzIHRvIHNpZ25hbCBjbWQvY3RybCBvbiBPUyBYXG4gIHZhciBmbGlwQ3RybENtZCA9IG1hYyAmJiAocXR3ZWJraXQgfHwgcHJlc3RvICYmIChwcmVzdG9fdmVyc2lvbiA9PSBudWxsIHx8IHByZXN0b192ZXJzaW9uIDwgMTIuMTEpKTtcbiAgdmFyIGNhcHR1cmVSaWdodENsaWNrID0gZ2Vja28gfHwgKGllICYmIGllX3ZlcnNpb24gPj0gOSk7XG5cbiAgLy8gT3B0aW1pemUgc29tZSBjb2RlIHdoZW4gdGhlc2UgZmVhdHVyZXMgYXJlIG5vdCB1c2VkLlxuICB2YXIgc2F3UmVhZE9ubHlTcGFucyA9IGZhbHNlLCBzYXdDb2xsYXBzZWRTcGFucyA9IGZhbHNlO1xuXG4gIC8vIEVESVRPUiBDT05TVFJVQ1RPUlxuXG4gIC8vIEEgQ29kZU1pcnJvciBpbnN0YW5jZSByZXByZXNlbnRzIGFuIGVkaXRvci4gVGhpcyBpcyB0aGUgb2JqZWN0XG4gIC8vIHRoYXQgdXNlciBjb2RlIGlzIHVzdWFsbHkgZGVhbGluZyB3aXRoLlxuXG4gIGZ1bmN0aW9uIENvZGVNaXJyb3IocGxhY2UsIG9wdGlvbnMpIHtcbiAgICBpZiAoISh0aGlzIGluc3RhbmNlb2YgQ29kZU1pcnJvcikpIHJldHVybiBuZXcgQ29kZU1pcnJvcihwbGFjZSwgb3B0aW9ucyk7XG5cbiAgICB0aGlzLm9wdGlvbnMgPSBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcbiAgICAvLyBEZXRlcm1pbmUgZWZmZWN0aXZlIG9wdGlvbnMgYmFzZWQgb24gZ2l2ZW4gdmFsdWVzIGFuZCBkZWZhdWx0cy5cbiAgICBjb3B5T2JqKGRlZmF1bHRzLCBvcHRpb25zLCBmYWxzZSk7XG4gICAgc2V0R3V0dGVyc0ZvckxpbmVOdW1iZXJzKG9wdGlvbnMpO1xuXG4gICAgdmFyIGRvYyA9IG9wdGlvbnMudmFsdWU7XG4gICAgaWYgKHR5cGVvZiBkb2MgPT0gXCJzdHJpbmdcIikgZG9jID0gbmV3IERvYyhkb2MsIG9wdGlvbnMubW9kZSk7XG4gICAgdGhpcy5kb2MgPSBkb2M7XG5cbiAgICB2YXIgZGlzcGxheSA9IHRoaXMuZGlzcGxheSA9IG5ldyBEaXNwbGF5KHBsYWNlLCBkb2MpO1xuICAgIGRpc3BsYXkud3JhcHBlci5Db2RlTWlycm9yID0gdGhpcztcbiAgICB1cGRhdGVHdXR0ZXJzKHRoaXMpO1xuICAgIHRoZW1lQ2hhbmdlZCh0aGlzKTtcbiAgICBpZiAob3B0aW9ucy5saW5lV3JhcHBpbmcpXG4gICAgICB0aGlzLmRpc3BsYXkud3JhcHBlci5jbGFzc05hbWUgKz0gXCIgQ29kZU1pcnJvci13cmFwXCI7XG4gICAgaWYgKG9wdGlvbnMuYXV0b2ZvY3VzICYmICFtb2JpbGUpIGZvY3VzSW5wdXQodGhpcyk7XG5cbiAgICB0aGlzLnN0YXRlID0ge1xuICAgICAga2V5TWFwczogW10sICAvLyBzdG9yZXMgbWFwcyBhZGRlZCBieSBhZGRLZXlNYXBcbiAgICAgIG92ZXJsYXlzOiBbXSwgLy8gaGlnaGxpZ2h0aW5nIG92ZXJsYXlzLCBhcyBhZGRlZCBieSBhZGRPdmVybGF5XG4gICAgICBtb2RlR2VuOiAwLCAgIC8vIGJ1bXBlZCB3aGVuIG1vZGUvb3ZlcmxheSBjaGFuZ2VzLCB1c2VkIHRvIGludmFsaWRhdGUgaGlnaGxpZ2h0aW5nIGluZm9cbiAgICAgIG92ZXJ3cml0ZTogZmFsc2UsIGZvY3VzZWQ6IGZhbHNlLFxuICAgICAgc3VwcHJlc3NFZGl0czogZmFsc2UsIC8vIHVzZWQgdG8gZGlzYWJsZSBlZGl0aW5nIGR1cmluZyBrZXkgaGFuZGxlcnMgd2hlbiBpbiByZWFkT25seSBtb2RlXG4gICAgICBwYXN0ZUluY29taW5nOiBmYWxzZSwgY3V0SW5jb21pbmc6IGZhbHNlLCAvLyBoZWxwIHJlY29nbml6ZSBwYXN0ZS9jdXQgZWRpdHMgaW4gcmVhZElucHV0XG4gICAgICBkcmFnZ2luZ1RleHQ6IGZhbHNlLFxuICAgICAgaGlnaGxpZ2h0OiBuZXcgRGVsYXllZCgpIC8vIHN0b3JlcyBoaWdobGlnaHQgd29ya2VyIHRpbWVvdXRcbiAgICB9O1xuXG4gICAgLy8gT3ZlcnJpZGUgbWFnaWMgdGV4dGFyZWEgY29udGVudCByZXN0b3JlIHRoYXQgSUUgc29tZXRpbWVzIGRvZXNcbiAgICAvLyBvbiBvdXIgaGlkZGVuIHRleHRhcmVhIG9uIHJlbG9hZFxuICAgIGlmIChpZSAmJiBpZV92ZXJzaW9uIDwgMTEpIHNldFRpbWVvdXQoYmluZChyZXNldElucHV0LCB0aGlzLCB0cnVlKSwgMjApO1xuXG4gICAgcmVnaXN0ZXJFdmVudEhhbmRsZXJzKHRoaXMpO1xuICAgIGVuc3VyZUdsb2JhbEhhbmRsZXJzKCk7XG5cbiAgICB2YXIgY20gPSB0aGlzO1xuICAgIHJ1bkluT3AodGhpcywgZnVuY3Rpb24oKSB7XG4gICAgICBjbS5jdXJPcC5mb3JjZVVwZGF0ZSA9IHRydWU7XG4gICAgICBhdHRhY2hEb2MoY20sIGRvYyk7XG5cbiAgICAgIGlmICgob3B0aW9ucy5hdXRvZm9jdXMgJiYgIW1vYmlsZSkgfHwgYWN0aXZlRWx0KCkgPT0gZGlzcGxheS5pbnB1dClcbiAgICAgICAgc2V0VGltZW91dChiaW5kKG9uRm9jdXMsIGNtKSwgMjApO1xuICAgICAgZWxzZVxuICAgICAgICBvbkJsdXIoY20pO1xuXG4gICAgICBmb3IgKHZhciBvcHQgaW4gb3B0aW9uSGFuZGxlcnMpIGlmIChvcHRpb25IYW5kbGVycy5oYXNPd25Qcm9wZXJ0eShvcHQpKVxuICAgICAgICBvcHRpb25IYW5kbGVyc1tvcHRdKGNtLCBvcHRpb25zW29wdF0sIEluaXQpO1xuICAgICAgbWF5YmVVcGRhdGVMaW5lTnVtYmVyV2lkdGgoY20pO1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBpbml0SG9va3MubGVuZ3RoOyArK2kpIGluaXRIb29rc1tpXShjbSk7XG4gICAgfSk7XG4gIH1cblxuICAvLyBESVNQTEFZIENPTlNUUlVDVE9SXG5cbiAgLy8gVGhlIGRpc3BsYXkgaGFuZGxlcyB0aGUgRE9NIGludGVncmF0aW9uLCBib3RoIGZvciBpbnB1dCByZWFkaW5nXG4gIC8vIGFuZCBjb250ZW50IGRyYXdpbmcuIEl0IGhvbGRzIHJlZmVyZW5jZXMgdG8gRE9NIG5vZGVzIGFuZFxuICAvLyBkaXNwbGF5LXJlbGF0ZWQgc3RhdGUuXG5cbiAgZnVuY3Rpb24gRGlzcGxheShwbGFjZSwgZG9jKSB7XG4gICAgdmFyIGQgPSB0aGlzO1xuXG4gICAgLy8gVGhlIHNlbWloaWRkZW4gdGV4dGFyZWEgdGhhdCBpcyBmb2N1c2VkIHdoZW4gdGhlIGVkaXRvciBpc1xuICAgIC8vIGZvY3VzZWQsIGFuZCByZWNlaXZlcyBpbnB1dC5cbiAgICB2YXIgaW5wdXQgPSBkLmlucHV0ID0gZWx0KFwidGV4dGFyZWFcIiwgbnVsbCwgbnVsbCwgXCJwb3NpdGlvbjogYWJzb2x1dGU7IHBhZGRpbmc6IDA7IHdpZHRoOiAxcHg7IGhlaWdodDogMWVtOyBvdXRsaW5lOiBub25lXCIpO1xuICAgIC8vIFRoZSB0ZXh0YXJlYSBpcyBrZXB0IHBvc2l0aW9uZWQgbmVhciB0aGUgY3Vyc29yIHRvIHByZXZlbnQgdGhlXG4gICAgLy8gZmFjdCB0aGF0IGl0J2xsIGJlIHNjcm9sbGVkIGludG8gdmlldyBvbiBpbnB1dCBmcm9tIHNjcm9sbGluZ1xuICAgIC8vIG91ciBmYWtlIGN1cnNvciBvdXQgb2Ygdmlldy4gT24gd2Via2l0LCB3aGVuIHdyYXA9b2ZmLCBwYXN0ZSBpc1xuICAgIC8vIHZlcnkgc2xvdy4gU28gbWFrZSB0aGUgYXJlYSB3aWRlIGluc3RlYWQuXG4gICAgaWYgKHdlYmtpdCkgaW5wdXQuc3R5bGUud2lkdGggPSBcIjEwMDBweFwiO1xuICAgIGVsc2UgaW5wdXQuc2V0QXR0cmlidXRlKFwid3JhcFwiLCBcIm9mZlwiKTtcbiAgICAvLyBJZiBib3JkZXI6IDA7IC0tIGlPUyBmYWlscyB0byBvcGVuIGtleWJvYXJkIChpc3N1ZSAjMTI4NylcbiAgICBpZiAoaW9zKSBpbnB1dC5zdHlsZS5ib3JkZXIgPSBcIjFweCBzb2xpZCBibGFja1wiO1xuICAgIGlucHV0LnNldEF0dHJpYnV0ZShcImF1dG9jb3JyZWN0XCIsIFwib2ZmXCIpOyBpbnB1dC5zZXRBdHRyaWJ1dGUoXCJhdXRvY2FwaXRhbGl6ZVwiLCBcIm9mZlwiKTsgaW5wdXQuc2V0QXR0cmlidXRlKFwic3BlbGxjaGVja1wiLCBcImZhbHNlXCIpO1xuXG4gICAgLy8gV3JhcHMgYW5kIGhpZGVzIGlucHV0IHRleHRhcmVhXG4gICAgZC5pbnB1dERpdiA9IGVsdChcImRpdlwiLCBbaW5wdXRdLCBudWxsLCBcIm92ZXJmbG93OiBoaWRkZW47IHBvc2l0aW9uOiByZWxhdGl2ZTsgd2lkdGg6IDNweDsgaGVpZ2h0OiAwcHg7XCIpO1xuICAgIC8vIFRoZSBmYWtlIHNjcm9sbGJhciBlbGVtZW50cy5cbiAgICBkLnNjcm9sbGJhckggPSBlbHQoXCJkaXZcIiwgW2VsdChcImRpdlwiLCBudWxsLCBudWxsLCBcImhlaWdodDogMTAwJTsgbWluLWhlaWdodDogMXB4XCIpXSwgXCJDb2RlTWlycm9yLWhzY3JvbGxiYXJcIik7XG4gICAgZC5zY3JvbGxiYXJWID0gZWx0KFwiZGl2XCIsIFtlbHQoXCJkaXZcIiwgbnVsbCwgbnVsbCwgXCJtaW4td2lkdGg6IDFweFwiKV0sIFwiQ29kZU1pcnJvci12c2Nyb2xsYmFyXCIpO1xuICAgIC8vIENvdmVycyBib3R0b20tcmlnaHQgc3F1YXJlIHdoZW4gYm90aCBzY3JvbGxiYXJzIGFyZSBwcmVzZW50LlxuICAgIGQuc2Nyb2xsYmFyRmlsbGVyID0gZWx0KFwiZGl2XCIsIG51bGwsIFwiQ29kZU1pcnJvci1zY3JvbGxiYXItZmlsbGVyXCIpO1xuICAgIC8vIENvdmVycyBib3R0b20gb2YgZ3V0dGVyIHdoZW4gY292ZXJHdXR0ZXJOZXh0VG9TY3JvbGxiYXIgaXMgb25cbiAgICAvLyBhbmQgaCBzY3JvbGxiYXIgaXMgcHJlc2VudC5cbiAgICBkLmd1dHRlckZpbGxlciA9IGVsdChcImRpdlwiLCBudWxsLCBcIkNvZGVNaXJyb3ItZ3V0dGVyLWZpbGxlclwiKTtcbiAgICAvLyBXaWxsIGNvbnRhaW4gdGhlIGFjdHVhbCBjb2RlLCBwb3NpdGlvbmVkIHRvIGNvdmVyIHRoZSB2aWV3cG9ydC5cbiAgICBkLmxpbmVEaXYgPSBlbHQoXCJkaXZcIiwgbnVsbCwgXCJDb2RlTWlycm9yLWNvZGVcIik7XG4gICAgLy8gRWxlbWVudHMgYXJlIGFkZGVkIHRvIHRoZXNlIHRvIHJlcHJlc2VudCBzZWxlY3Rpb24gYW5kIGN1cnNvcnMuXG4gICAgZC5zZWxlY3Rpb25EaXYgPSBlbHQoXCJkaXZcIiwgbnVsbCwgbnVsbCwgXCJwb3NpdGlvbjogcmVsYXRpdmU7IHotaW5kZXg6IDFcIik7XG4gICAgZC5jdXJzb3JEaXYgPSBlbHQoXCJkaXZcIiwgbnVsbCwgXCJDb2RlTWlycm9yLWN1cnNvcnNcIik7XG4gICAgLy8gQSB2aXNpYmlsaXR5OiBoaWRkZW4gZWxlbWVudCB1c2VkIHRvIGZpbmQgdGhlIHNpemUgb2YgdGhpbmdzLlxuICAgIGQubWVhc3VyZSA9IGVsdChcImRpdlwiLCBudWxsLCBcIkNvZGVNaXJyb3ItbWVhc3VyZVwiKTtcbiAgICAvLyBXaGVuIGxpbmVzIG91dHNpZGUgb2YgdGhlIHZpZXdwb3J0IGFyZSBtZWFzdXJlZCwgdGhleSBhcmUgZHJhd24gaW4gdGhpcy5cbiAgICBkLmxpbmVNZWFzdXJlID0gZWx0KFwiZGl2XCIsIG51bGwsIFwiQ29kZU1pcnJvci1tZWFzdXJlXCIpO1xuICAgIC8vIFdyYXBzIGV2ZXJ5dGhpbmcgdGhhdCBuZWVkcyB0byBleGlzdCBpbnNpZGUgdGhlIHZlcnRpY2FsbHktcGFkZGVkIGNvb3JkaW5hdGUgc3lzdGVtXG4gICAgZC5saW5lU3BhY2UgPSBlbHQoXCJkaXZcIiwgW2QubWVhc3VyZSwgZC5saW5lTWVhc3VyZSwgZC5zZWxlY3Rpb25EaXYsIGQuY3Vyc29yRGl2LCBkLmxpbmVEaXZdLFxuICAgICAgICAgICAgICAgICAgICAgIG51bGwsIFwicG9zaXRpb246IHJlbGF0aXZlOyBvdXRsaW5lOiBub25lXCIpO1xuICAgIC8vIE1vdmVkIGFyb3VuZCBpdHMgcGFyZW50IHRvIGNvdmVyIHZpc2libGUgdmlldy5cbiAgICBkLm1vdmVyID0gZWx0KFwiZGl2XCIsIFtlbHQoXCJkaXZcIiwgW2QubGluZVNwYWNlXSwgXCJDb2RlTWlycm9yLWxpbmVzXCIpXSwgbnVsbCwgXCJwb3NpdGlvbjogcmVsYXRpdmVcIik7XG4gICAgLy8gU2V0IHRvIHRoZSBoZWlnaHQgb2YgdGhlIGRvY3VtZW50LCBhbGxvd2luZyBzY3JvbGxpbmcuXG4gICAgZC5zaXplciA9IGVsdChcImRpdlwiLCBbZC5tb3Zlcl0sIFwiQ29kZU1pcnJvci1zaXplclwiKTtcbiAgICAvLyBCZWhhdmlvciBvZiBlbHRzIHdpdGggb3ZlcmZsb3c6IGF1dG8gYW5kIHBhZGRpbmcgaXNcbiAgICAvLyBpbmNvbnNpc3RlbnQgYWNyb3NzIGJyb3dzZXJzLiBUaGlzIGlzIHVzZWQgdG8gZW5zdXJlIHRoZVxuICAgIC8vIHNjcm9sbGFibGUgYXJlYSBpcyBiaWcgZW5vdWdoLlxuICAgIGQuaGVpZ2h0Rm9yY2VyID0gZWx0KFwiZGl2XCIsIG51bGwsIG51bGwsIFwicG9zaXRpb246IGFic29sdXRlOyBoZWlnaHQ6IFwiICsgc2Nyb2xsZXJDdXRPZmYgKyBcInB4OyB3aWR0aDogMXB4O1wiKTtcbiAgICAvLyBXaWxsIGNvbnRhaW4gdGhlIGd1dHRlcnMsIGlmIGFueS5cbiAgICBkLmd1dHRlcnMgPSBlbHQoXCJkaXZcIiwgbnVsbCwgXCJDb2RlTWlycm9yLWd1dHRlcnNcIik7XG4gICAgZC5saW5lR3V0dGVyID0gbnVsbDtcbiAgICAvLyBBY3R1YWwgc2Nyb2xsYWJsZSBlbGVtZW50LlxuICAgIGQuc2Nyb2xsZXIgPSBlbHQoXCJkaXZcIiwgW2Quc2l6ZXIsIGQuaGVpZ2h0Rm9yY2VyLCBkLmd1dHRlcnNdLCBcIkNvZGVNaXJyb3Itc2Nyb2xsXCIpO1xuICAgIGQuc2Nyb2xsZXIuc2V0QXR0cmlidXRlKFwidGFiSW5kZXhcIiwgXCItMVwiKTtcbiAgICAvLyBUaGUgZWxlbWVudCBpbiB3aGljaCB0aGUgZWRpdG9yIGxpdmVzLlxuICAgIGQud3JhcHBlciA9IGVsdChcImRpdlwiLCBbZC5pbnB1dERpdiwgZC5zY3JvbGxiYXJILCBkLnNjcm9sbGJhclYsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZC5zY3JvbGxiYXJGaWxsZXIsIGQuZ3V0dGVyRmlsbGVyLCBkLnNjcm9sbGVyXSwgXCJDb2RlTWlycm9yXCIpO1xuXG4gICAgLy8gV29yayBhcm91bmQgSUU3IHotaW5kZXggYnVnIChub3QgcGVyZmVjdCwgaGVuY2UgSUU3IG5vdCByZWFsbHkgYmVpbmcgc3VwcG9ydGVkKVxuICAgIGlmIChpZSAmJiBpZV92ZXJzaW9uIDwgOCkgeyBkLmd1dHRlcnMuc3R5bGUuekluZGV4ID0gLTE7IGQuc2Nyb2xsZXIuc3R5bGUucGFkZGluZ1JpZ2h0ID0gMDsgfVxuICAgIC8vIE5lZWRlZCB0byBoaWRlIGJpZyBibHVlIGJsaW5raW5nIGN1cnNvciBvbiBNb2JpbGUgU2FmYXJpXG4gICAgaWYgKGlvcykgaW5wdXQuc3R5bGUud2lkdGggPSBcIjBweFwiO1xuICAgIGlmICghd2Via2l0KSBkLnNjcm9sbGVyLmRyYWdnYWJsZSA9IHRydWU7XG4gICAgLy8gTmVlZGVkIHRvIGhhbmRsZSBUYWIga2V5IGluIEtIVE1MXG4gICAgaWYgKGtodG1sKSB7IGQuaW5wdXREaXYuc3R5bGUuaGVpZ2h0ID0gXCIxcHhcIjsgZC5pbnB1dERpdi5zdHlsZS5wb3NpdGlvbiA9IFwiYWJzb2x1dGVcIjsgfVxuICAgIC8vIE5lZWQgdG8gc2V0IGEgbWluaW11bSB3aWR0aCB0byBzZWUgdGhlIHNjcm9sbGJhciBvbiBJRTcgKGJ1dCBtdXN0IG5vdCBzZXQgaXQgb24gSUU4KS5cbiAgICBpZiAoaWUgJiYgaWVfdmVyc2lvbiA8IDgpIGQuc2Nyb2xsYmFySC5zdHlsZS5taW5IZWlnaHQgPSBkLnNjcm9sbGJhclYuc3R5bGUubWluV2lkdGggPSBcIjE4cHhcIjtcblxuICAgIGlmIChwbGFjZS5hcHBlbmRDaGlsZCkgcGxhY2UuYXBwZW5kQ2hpbGQoZC53cmFwcGVyKTtcbiAgICBlbHNlIHBsYWNlKGQud3JhcHBlcik7XG5cbiAgICAvLyBDdXJyZW50IHJlbmRlcmVkIHJhbmdlIChtYXkgYmUgYmlnZ2VyIHRoYW4gdGhlIHZpZXcgd2luZG93KS5cbiAgICBkLnZpZXdGcm9tID0gZC52aWV3VG8gPSBkb2MuZmlyc3Q7XG4gICAgLy8gSW5mb3JtYXRpb24gYWJvdXQgdGhlIHJlbmRlcmVkIGxpbmVzLlxuICAgIGQudmlldyA9IFtdO1xuICAgIC8vIEhvbGRzIGluZm8gYWJvdXQgYSBzaW5nbGUgcmVuZGVyZWQgbGluZSB3aGVuIGl0IHdhcyByZW5kZXJlZFxuICAgIC8vIGZvciBtZWFzdXJlbWVudCwgd2hpbGUgbm90IGluIHZpZXcuXG4gICAgZC5leHRlcm5hbE1lYXN1cmVkID0gbnVsbDtcbiAgICAvLyBFbXB0eSBzcGFjZSAoaW4gcGl4ZWxzKSBhYm92ZSB0aGUgdmlld1xuICAgIGQudmlld09mZnNldCA9IDA7XG4gICAgZC5sYXN0U2l6ZUMgPSAwO1xuICAgIGQudXBkYXRlTGluZU51bWJlcnMgPSBudWxsO1xuXG4gICAgLy8gVXNlZCB0byBvbmx5IHJlc2l6ZSB0aGUgbGluZSBudW1iZXIgZ3V0dGVyIHdoZW4gbmVjZXNzYXJ5ICh3aGVuXG4gICAgLy8gdGhlIGFtb3VudCBvZiBsaW5lcyBjcm9zc2VzIGEgYm91bmRhcnkgdGhhdCBtYWtlcyBpdHMgd2lkdGggY2hhbmdlKVxuICAgIGQubGluZU51bVdpZHRoID0gZC5saW5lTnVtSW5uZXJXaWR0aCA9IGQubGluZU51bUNoYXJzID0gbnVsbDtcbiAgICAvLyBTZWUgcmVhZElucHV0IGFuZCByZXNldElucHV0XG4gICAgZC5wcmV2SW5wdXQgPSBcIlwiO1xuICAgIC8vIFNldCB0byB0cnVlIHdoZW4gYSBub24taG9yaXpvbnRhbC1zY3JvbGxpbmcgbGluZSB3aWRnZXQgaXNcbiAgICAvLyBhZGRlZC4gQXMgYW4gb3B0aW1pemF0aW9uLCBsaW5lIHdpZGdldCBhbGlnbmluZyBpcyBza2lwcGVkIHdoZW5cbiAgICAvLyB0aGlzIGlzIGZhbHNlLlxuICAgIGQuYWxpZ25XaWRnZXRzID0gZmFsc2U7XG4gICAgLy8gRmxhZyB0aGF0IGluZGljYXRlcyB3aGV0aGVyIHdlIGV4cGVjdCBpbnB1dCB0byBhcHBlYXIgcmVhbCBzb29uXG4gICAgLy8gbm93IChhZnRlciBzb21lIGV2ZW50IGxpa2UgJ2tleXByZXNzJyBvciAnaW5wdXQnKSBhbmQgYXJlXG4gICAgLy8gcG9sbGluZyBpbnRlbnNpdmVseS5cbiAgICBkLnBvbGxpbmdGYXN0ID0gZmFsc2U7XG4gICAgLy8gU2VsZi1yZXNldHRpbmcgdGltZW91dCBmb3IgdGhlIHBvbGxlclxuICAgIGQucG9sbCA9IG5ldyBEZWxheWVkKCk7XG5cbiAgICBkLmNhY2hlZENoYXJXaWR0aCA9IGQuY2FjaGVkVGV4dEhlaWdodCA9IGQuY2FjaGVkUGFkZGluZ0ggPSBudWxsO1xuXG4gICAgLy8gVHJhY2tzIHdoZW4gcmVzZXRJbnB1dCBoYXMgcHVudGVkIHRvIGp1c3QgcHV0dGluZyBhIHNob3J0XG4gICAgLy8gc3RyaW5nIGludG8gdGhlIHRleHRhcmVhIGluc3RlYWQgb2YgdGhlIGZ1bGwgc2VsZWN0aW9uLlxuICAgIGQuaW5hY2N1cmF0ZVNlbGVjdGlvbiA9IGZhbHNlO1xuXG4gICAgLy8gVHJhY2tzIHRoZSBtYXhpbXVtIGxpbmUgbGVuZ3RoIHNvIHRoYXQgdGhlIGhvcml6b250YWwgc2Nyb2xsYmFyXG4gICAgLy8gY2FuIGJlIGtlcHQgc3RhdGljIHdoZW4gc2Nyb2xsaW5nLlxuICAgIGQubWF4TGluZSA9IG51bGw7XG4gICAgZC5tYXhMaW5lTGVuZ3RoID0gMDtcbiAgICBkLm1heExpbmVDaGFuZ2VkID0gZmFsc2U7XG5cbiAgICAvLyBVc2VkIGZvciBtZWFzdXJpbmcgd2hlZWwgc2Nyb2xsaW5nIGdyYW51bGFyaXR5XG4gICAgZC53aGVlbERYID0gZC53aGVlbERZID0gZC53aGVlbFN0YXJ0WCA9IGQud2hlZWxTdGFydFkgPSBudWxsO1xuXG4gICAgLy8gVHJ1ZSB3aGVuIHNoaWZ0IGlzIGhlbGQgZG93bi5cbiAgICBkLnNoaWZ0ID0gZmFsc2U7XG5cbiAgICAvLyBVc2VkIHRvIHRyYWNrIHdoZXRoZXIgYW55dGhpbmcgaGFwcGVuZWQgc2luY2UgdGhlIGNvbnRleHQgbWVudVxuICAgIC8vIHdhcyBvcGVuZWQuXG4gICAgZC5zZWxGb3JDb250ZXh0TWVudSA9IG51bGw7XG4gIH1cblxuICAvLyBTVEFURSBVUERBVEVTXG5cbiAgLy8gVXNlZCB0byBnZXQgdGhlIGVkaXRvciBpbnRvIGEgY29uc2lzdGVudCBzdGF0ZSBhZ2FpbiB3aGVuIG9wdGlvbnMgY2hhbmdlLlxuXG4gIGZ1bmN0aW9uIGxvYWRNb2RlKGNtKSB7XG4gICAgY20uZG9jLm1vZGUgPSBDb2RlTWlycm9yLmdldE1vZGUoY20ub3B0aW9ucywgY20uZG9jLm1vZGVPcHRpb24pO1xuICAgIHJlc2V0TW9kZVN0YXRlKGNtKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHJlc2V0TW9kZVN0YXRlKGNtKSB7XG4gICAgY20uZG9jLml0ZXIoZnVuY3Rpb24obGluZSkge1xuICAgICAgaWYgKGxpbmUuc3RhdGVBZnRlcikgbGluZS5zdGF0ZUFmdGVyID0gbnVsbDtcbiAgICAgIGlmIChsaW5lLnN0eWxlcykgbGluZS5zdHlsZXMgPSBudWxsO1xuICAgIH0pO1xuICAgIGNtLmRvYy5mcm9udGllciA9IGNtLmRvYy5maXJzdDtcbiAgICBzdGFydFdvcmtlcihjbSwgMTAwKTtcbiAgICBjbS5zdGF0ZS5tb2RlR2VuKys7XG4gICAgaWYgKGNtLmN1ck9wKSByZWdDaGFuZ2UoY20pO1xuICB9XG5cbiAgZnVuY3Rpb24gd3JhcHBpbmdDaGFuZ2VkKGNtKSB7XG4gICAgaWYgKGNtLm9wdGlvbnMubGluZVdyYXBwaW5nKSB7XG4gICAgICBhZGRDbGFzcyhjbS5kaXNwbGF5LndyYXBwZXIsIFwiQ29kZU1pcnJvci13cmFwXCIpO1xuICAgICAgY20uZGlzcGxheS5zaXplci5zdHlsZS5taW5XaWR0aCA9IFwiXCI7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJtQ2xhc3MoY20uZGlzcGxheS53cmFwcGVyLCBcIkNvZGVNaXJyb3Itd3JhcFwiKTtcbiAgICAgIGZpbmRNYXhMaW5lKGNtKTtcbiAgICB9XG4gICAgZXN0aW1hdGVMaW5lSGVpZ2h0cyhjbSk7XG4gICAgcmVnQ2hhbmdlKGNtKTtcbiAgICBjbGVhckNhY2hlcyhjbSk7XG4gICAgc2V0VGltZW91dChmdW5jdGlvbigpe3VwZGF0ZVNjcm9sbGJhcnMoY20pO30sIDEwMCk7XG4gIH1cblxuICAvLyBSZXR1cm5zIGEgZnVuY3Rpb24gdGhhdCBlc3RpbWF0ZXMgdGhlIGhlaWdodCBvZiBhIGxpbmUsIHRvIHVzZSBhc1xuICAvLyBmaXJzdCBhcHByb3hpbWF0aW9uIHVudGlsIHRoZSBsaW5lIGJlY29tZXMgdmlzaWJsZSAoYW5kIGlzIHRodXNcbiAgLy8gcHJvcGVybHkgbWVhc3VyYWJsZSkuXG4gIGZ1bmN0aW9uIGVzdGltYXRlSGVpZ2h0KGNtKSB7XG4gICAgdmFyIHRoID0gdGV4dEhlaWdodChjbS5kaXNwbGF5KSwgd3JhcHBpbmcgPSBjbS5vcHRpb25zLmxpbmVXcmFwcGluZztcbiAgICB2YXIgcGVyTGluZSA9IHdyYXBwaW5nICYmIE1hdGgubWF4KDUsIGNtLmRpc3BsYXkuc2Nyb2xsZXIuY2xpZW50V2lkdGggLyBjaGFyV2lkdGgoY20uZGlzcGxheSkgLSAzKTtcbiAgICByZXR1cm4gZnVuY3Rpb24obGluZSkge1xuICAgICAgaWYgKGxpbmVJc0hpZGRlbihjbS5kb2MsIGxpbmUpKSByZXR1cm4gMDtcblxuICAgICAgdmFyIHdpZGdldHNIZWlnaHQgPSAwO1xuICAgICAgaWYgKGxpbmUud2lkZ2V0cykgZm9yICh2YXIgaSA9IDA7IGkgPCBsaW5lLndpZGdldHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgaWYgKGxpbmUud2lkZ2V0c1tpXS5oZWlnaHQpIHdpZGdldHNIZWlnaHQgKz0gbGluZS53aWRnZXRzW2ldLmhlaWdodDtcbiAgICAgIH1cblxuICAgICAgaWYgKHdyYXBwaW5nKVxuICAgICAgICByZXR1cm4gd2lkZ2V0c0hlaWdodCArIChNYXRoLmNlaWwobGluZS50ZXh0Lmxlbmd0aCAvIHBlckxpbmUpIHx8IDEpICogdGg7XG4gICAgICBlbHNlXG4gICAgICAgIHJldHVybiB3aWRnZXRzSGVpZ2h0ICsgdGg7XG4gICAgfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGVzdGltYXRlTGluZUhlaWdodHMoY20pIHtcbiAgICB2YXIgZG9jID0gY20uZG9jLCBlc3QgPSBlc3RpbWF0ZUhlaWdodChjbSk7XG4gICAgZG9jLml0ZXIoZnVuY3Rpb24obGluZSkge1xuICAgICAgdmFyIGVzdEhlaWdodCA9IGVzdChsaW5lKTtcbiAgICAgIGlmIChlc3RIZWlnaHQgIT0gbGluZS5oZWlnaHQpIHVwZGF0ZUxpbmVIZWlnaHQobGluZSwgZXN0SGVpZ2h0KTtcbiAgICB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGtleU1hcENoYW5nZWQoY20pIHtcbiAgICB2YXIgbWFwID0ga2V5TWFwW2NtLm9wdGlvbnMua2V5TWFwXSwgc3R5bGUgPSBtYXAuc3R5bGU7XG4gICAgY20uZGlzcGxheS53cmFwcGVyLmNsYXNzTmFtZSA9IGNtLmRpc3BsYXkud3JhcHBlci5jbGFzc05hbWUucmVwbGFjZSgvXFxzKmNtLWtleW1hcC1cXFMrL2csIFwiXCIpICtcbiAgICAgIChzdHlsZSA/IFwiIGNtLWtleW1hcC1cIiArIHN0eWxlIDogXCJcIik7XG4gIH1cblxuICBmdW5jdGlvbiB0aGVtZUNoYW5nZWQoY20pIHtcbiAgICBjbS5kaXNwbGF5LndyYXBwZXIuY2xhc3NOYW1lID0gY20uZGlzcGxheS53cmFwcGVyLmNsYXNzTmFtZS5yZXBsYWNlKC9cXHMqY20tcy1cXFMrL2csIFwiXCIpICtcbiAgICAgIGNtLm9wdGlvbnMudGhlbWUucmVwbGFjZSgvKF58XFxzKVxccyovZywgXCIgY20tcy1cIik7XG4gICAgY2xlYXJDYWNoZXMoY20pO1xuICB9XG5cbiAgZnVuY3Rpb24gZ3V0dGVyc0NoYW5nZWQoY20pIHtcbiAgICB1cGRhdGVHdXR0ZXJzKGNtKTtcbiAgICByZWdDaGFuZ2UoY20pO1xuICAgIHNldFRpbWVvdXQoZnVuY3Rpb24oKXthbGlnbkhvcml6b250YWxseShjbSk7fSwgMjApO1xuICB9XG5cbiAgLy8gUmVidWlsZCB0aGUgZ3V0dGVyIGVsZW1lbnRzLCBlbnN1cmUgdGhlIG1hcmdpbiB0byB0aGUgbGVmdCBvZiB0aGVcbiAgLy8gY29kZSBtYXRjaGVzIHRoZWlyIHdpZHRoLlxuICBmdW5jdGlvbiB1cGRhdGVHdXR0ZXJzKGNtKSB7XG4gICAgdmFyIGd1dHRlcnMgPSBjbS5kaXNwbGF5Lmd1dHRlcnMsIHNwZWNzID0gY20ub3B0aW9ucy5ndXR0ZXJzO1xuICAgIHJlbW92ZUNoaWxkcmVuKGd1dHRlcnMpO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgc3BlY3MubGVuZ3RoOyArK2kpIHtcbiAgICAgIHZhciBndXR0ZXJDbGFzcyA9IHNwZWNzW2ldO1xuICAgICAgdmFyIGdFbHQgPSBndXR0ZXJzLmFwcGVuZENoaWxkKGVsdChcImRpdlwiLCBudWxsLCBcIkNvZGVNaXJyb3ItZ3V0dGVyIFwiICsgZ3V0dGVyQ2xhc3MpKTtcbiAgICAgIGlmIChndXR0ZXJDbGFzcyA9PSBcIkNvZGVNaXJyb3ItbGluZW51bWJlcnNcIikge1xuICAgICAgICBjbS5kaXNwbGF5LmxpbmVHdXR0ZXIgPSBnRWx0O1xuICAgICAgICBnRWx0LnN0eWxlLndpZHRoID0gKGNtLmRpc3BsYXkubGluZU51bVdpZHRoIHx8IDEpICsgXCJweFwiO1xuICAgICAgfVxuICAgIH1cbiAgICBndXR0ZXJzLnN0eWxlLmRpc3BsYXkgPSBpID8gXCJcIiA6IFwibm9uZVwiO1xuICAgIHVwZGF0ZUd1dHRlclNwYWNlKGNtKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHVwZGF0ZUd1dHRlclNwYWNlKGNtKSB7XG4gICAgdmFyIHdpZHRoID0gY20uZGlzcGxheS5ndXR0ZXJzLm9mZnNldFdpZHRoO1xuICAgIGNtLmRpc3BsYXkuc2l6ZXIuc3R5bGUubWFyZ2luTGVmdCA9IHdpZHRoICsgXCJweFwiO1xuICAgIGNtLmRpc3BsYXkuc2Nyb2xsYmFySC5zdHlsZS5sZWZ0ID0gY20ub3B0aW9ucy5maXhlZEd1dHRlciA/IHdpZHRoICsgXCJweFwiIDogMDtcbiAgfVxuXG4gIC8vIENvbXB1dGUgdGhlIGNoYXJhY3RlciBsZW5ndGggb2YgYSBsaW5lLCB0YWtpbmcgaW50byBhY2NvdW50XG4gIC8vIGNvbGxhcHNlZCByYW5nZXMgKHNlZSBtYXJrVGV4dCkgdGhhdCBtaWdodCBoaWRlIHBhcnRzLCBhbmQgam9pblxuICAvLyBvdGhlciBsaW5lcyBvbnRvIGl0LlxuICBmdW5jdGlvbiBsaW5lTGVuZ3RoKGxpbmUpIHtcbiAgICBpZiAobGluZS5oZWlnaHQgPT0gMCkgcmV0dXJuIDA7XG4gICAgdmFyIGxlbiA9IGxpbmUudGV4dC5sZW5ndGgsIG1lcmdlZCwgY3VyID0gbGluZTtcbiAgICB3aGlsZSAobWVyZ2VkID0gY29sbGFwc2VkU3BhbkF0U3RhcnQoY3VyKSkge1xuICAgICAgdmFyIGZvdW5kID0gbWVyZ2VkLmZpbmQoMCwgdHJ1ZSk7XG4gICAgICBjdXIgPSBmb3VuZC5mcm9tLmxpbmU7XG4gICAgICBsZW4gKz0gZm91bmQuZnJvbS5jaCAtIGZvdW5kLnRvLmNoO1xuICAgIH1cbiAgICBjdXIgPSBsaW5lO1xuICAgIHdoaWxlIChtZXJnZWQgPSBjb2xsYXBzZWRTcGFuQXRFbmQoY3VyKSkge1xuICAgICAgdmFyIGZvdW5kID0gbWVyZ2VkLmZpbmQoMCwgdHJ1ZSk7XG4gICAgICBsZW4gLT0gY3VyLnRleHQubGVuZ3RoIC0gZm91bmQuZnJvbS5jaDtcbiAgICAgIGN1ciA9IGZvdW5kLnRvLmxpbmU7XG4gICAgICBsZW4gKz0gY3VyLnRleHQubGVuZ3RoIC0gZm91bmQudG8uY2g7XG4gICAgfVxuICAgIHJldHVybiBsZW47XG4gIH1cblxuICAvLyBGaW5kIHRoZSBsb25nZXN0IGxpbmUgaW4gdGhlIGRvY3VtZW50LlxuICBmdW5jdGlvbiBmaW5kTWF4TGluZShjbSkge1xuICAgIHZhciBkID0gY20uZGlzcGxheSwgZG9jID0gY20uZG9jO1xuICAgIGQubWF4TGluZSA9IGdldExpbmUoZG9jLCBkb2MuZmlyc3QpO1xuICAgIGQubWF4TGluZUxlbmd0aCA9IGxpbmVMZW5ndGgoZC5tYXhMaW5lKTtcbiAgICBkLm1heExpbmVDaGFuZ2VkID0gdHJ1ZTtcbiAgICBkb2MuaXRlcihmdW5jdGlvbihsaW5lKSB7XG4gICAgICB2YXIgbGVuID0gbGluZUxlbmd0aChsaW5lKTtcbiAgICAgIGlmIChsZW4gPiBkLm1heExpbmVMZW5ndGgpIHtcbiAgICAgICAgZC5tYXhMaW5lTGVuZ3RoID0gbGVuO1xuICAgICAgICBkLm1heExpbmUgPSBsaW5lO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgLy8gTWFrZSBzdXJlIHRoZSBndXR0ZXJzIG9wdGlvbnMgY29udGFpbnMgdGhlIGVsZW1lbnRcbiAgLy8gXCJDb2RlTWlycm9yLWxpbmVudW1iZXJzXCIgd2hlbiB0aGUgbGluZU51bWJlcnMgb3B0aW9uIGlzIHRydWUuXG4gIGZ1bmN0aW9uIHNldEd1dHRlcnNGb3JMaW5lTnVtYmVycyhvcHRpb25zKSB7XG4gICAgdmFyIGZvdW5kID0gaW5kZXhPZihvcHRpb25zLmd1dHRlcnMsIFwiQ29kZU1pcnJvci1saW5lbnVtYmVyc1wiKTtcbiAgICBpZiAoZm91bmQgPT0gLTEgJiYgb3B0aW9ucy5saW5lTnVtYmVycykge1xuICAgICAgb3B0aW9ucy5ndXR0ZXJzID0gb3B0aW9ucy5ndXR0ZXJzLmNvbmNhdChbXCJDb2RlTWlycm9yLWxpbmVudW1iZXJzXCJdKTtcbiAgICB9IGVsc2UgaWYgKGZvdW5kID4gLTEgJiYgIW9wdGlvbnMubGluZU51bWJlcnMpIHtcbiAgICAgIG9wdGlvbnMuZ3V0dGVycyA9IG9wdGlvbnMuZ3V0dGVycy5zbGljZSgwKTtcbiAgICAgIG9wdGlvbnMuZ3V0dGVycy5zcGxpY2UoZm91bmQsIDEpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFNDUk9MTEJBUlNcblxuICBmdW5jdGlvbiBoU2Nyb2xsYmFyVGFrZXNTcGFjZShjbSkge1xuICAgIHJldHVybiBjbS5kaXNwbGF5LnNjcm9sbGVyLmNsaWVudEhlaWdodCAtIGNtLmRpc3BsYXkud3JhcHBlci5jbGllbnRIZWlnaHQgPCBzY3JvbGxlckN1dE9mZiAtIDM7XG4gIH1cblxuICAvLyBQcmVwYXJlIERPTSByZWFkcyBuZWVkZWQgdG8gdXBkYXRlIHRoZSBzY3JvbGxiYXJzLiBEb25lIGluIG9uZVxuICAvLyBzaG90IHRvIG1pbmltaXplIHVwZGF0ZS9tZWFzdXJlIHJvdW5kdHJpcHMuXG4gIGZ1bmN0aW9uIG1lYXN1cmVGb3JTY3JvbGxiYXJzKGNtKSB7XG4gICAgdmFyIHNjcm9sbCA9IGNtLmRpc3BsYXkuc2Nyb2xsZXI7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNsaWVudEhlaWdodDogc2Nyb2xsLmNsaWVudEhlaWdodCxcbiAgICAgIGJhckhlaWdodDogY20uZGlzcGxheS5zY3JvbGxiYXJWLmNsaWVudEhlaWdodCxcbiAgICAgIHNjcm9sbFdpZHRoOiBzY3JvbGwuc2Nyb2xsV2lkdGgsIGNsaWVudFdpZHRoOiBzY3JvbGwuY2xpZW50V2lkdGgsXG4gICAgICBoU2Nyb2xsYmFyVGFrZXNTcGFjZTogaFNjcm9sbGJhclRha2VzU3BhY2UoY20pLFxuICAgICAgYmFyV2lkdGg6IGNtLmRpc3BsYXkuc2Nyb2xsYmFySC5jbGllbnRXaWR0aCxcbiAgICAgIGRvY0hlaWdodDogTWF0aC5yb3VuZChjbS5kb2MuaGVpZ2h0ICsgcGFkZGluZ1ZlcnQoY20uZGlzcGxheSkpXG4gICAgfTtcbiAgfVxuXG4gIC8vIFJlLXN5bmNocm9uaXplIHRoZSBmYWtlIHNjcm9sbGJhcnMgd2l0aCB0aGUgYWN0dWFsIHNpemUgb2YgdGhlXG4gIC8vIGNvbnRlbnQuXG4gIGZ1bmN0aW9uIHVwZGF0ZVNjcm9sbGJhcnMoY20sIG1lYXN1cmUpIHtcbiAgICBpZiAoIW1lYXN1cmUpIG1lYXN1cmUgPSBtZWFzdXJlRm9yU2Nyb2xsYmFycyhjbSk7XG4gICAgdmFyIGQgPSBjbS5kaXNwbGF5LCBzV2lkdGggPSBzY3JvbGxiYXJXaWR0aChkLm1lYXN1cmUpO1xuICAgIHZhciBzY3JvbGxIZWlnaHQgPSBtZWFzdXJlLmRvY0hlaWdodCArIHNjcm9sbGVyQ3V0T2ZmO1xuICAgIHZhciBuZWVkc0ggPSBtZWFzdXJlLnNjcm9sbFdpZHRoID4gbWVhc3VyZS5jbGllbnRXaWR0aDtcbiAgICBpZiAobmVlZHNIICYmIG1lYXN1cmUuc2Nyb2xsV2lkdGggPD0gbWVhc3VyZS5jbGllbnRXaWR0aCArIDEgJiZcbiAgICAgICAgc1dpZHRoID4gMCAmJiAhbWVhc3VyZS5oU2Nyb2xsYmFyVGFrZXNTcGFjZSlcbiAgICAgIG5lZWRzSCA9IGZhbHNlOyAvLyAoSXNzdWUgIzI1NjIpXG4gICAgdmFyIG5lZWRzViA9IHNjcm9sbEhlaWdodCA+IG1lYXN1cmUuY2xpZW50SGVpZ2h0O1xuXG4gICAgaWYgKG5lZWRzVikge1xuICAgICAgZC5zY3JvbGxiYXJWLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG4gICAgICBkLnNjcm9sbGJhclYuc3R5bGUuYm90dG9tID0gbmVlZHNIID8gc1dpZHRoICsgXCJweFwiIDogXCIwXCI7XG4gICAgICAvLyBBIGJ1ZyBpbiBJRTggY2FuIGNhdXNlIHRoaXMgdmFsdWUgdG8gYmUgbmVnYXRpdmUsIHNvIGd1YXJkIGl0LlxuICAgICAgZC5zY3JvbGxiYXJWLmZpcnN0Q2hpbGQuc3R5bGUuaGVpZ2h0ID1cbiAgICAgICAgTWF0aC5tYXgoMCwgc2Nyb2xsSGVpZ2h0IC0gbWVhc3VyZS5jbGllbnRIZWlnaHQgKyAobWVhc3VyZS5iYXJIZWlnaHQgfHwgZC5zY3JvbGxiYXJWLmNsaWVudEhlaWdodCkpICsgXCJweFwiO1xuICAgIH0gZWxzZSB7XG4gICAgICBkLnNjcm9sbGJhclYuc3R5bGUuZGlzcGxheSA9IFwiXCI7XG4gICAgICBkLnNjcm9sbGJhclYuZmlyc3RDaGlsZC5zdHlsZS5oZWlnaHQgPSBcIjBcIjtcbiAgICB9XG4gICAgaWYgKG5lZWRzSCkge1xuICAgICAgZC5zY3JvbGxiYXJILnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG4gICAgICBkLnNjcm9sbGJhckguc3R5bGUucmlnaHQgPSBuZWVkc1YgPyBzV2lkdGggKyBcInB4XCIgOiBcIjBcIjtcbiAgICAgIGQuc2Nyb2xsYmFySC5maXJzdENoaWxkLnN0eWxlLndpZHRoID1cbiAgICAgICAgKG1lYXN1cmUuc2Nyb2xsV2lkdGggLSBtZWFzdXJlLmNsaWVudFdpZHRoICsgKG1lYXN1cmUuYmFyV2lkdGggfHwgZC5zY3JvbGxiYXJILmNsaWVudFdpZHRoKSkgKyBcInB4XCI7XG4gICAgfSBlbHNlIHtcbiAgICAgIGQuc2Nyb2xsYmFySC5zdHlsZS5kaXNwbGF5ID0gXCJcIjtcbiAgICAgIGQuc2Nyb2xsYmFySC5maXJzdENoaWxkLnN0eWxlLndpZHRoID0gXCIwXCI7XG4gICAgfVxuICAgIGlmIChuZWVkc0ggJiYgbmVlZHNWKSB7XG4gICAgICBkLnNjcm9sbGJhckZpbGxlci5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xuICAgICAgZC5zY3JvbGxiYXJGaWxsZXIuc3R5bGUuaGVpZ2h0ID0gZC5zY3JvbGxiYXJGaWxsZXIuc3R5bGUud2lkdGggPSBzV2lkdGggKyBcInB4XCI7XG4gICAgfSBlbHNlIGQuc2Nyb2xsYmFyRmlsbGVyLnN0eWxlLmRpc3BsYXkgPSBcIlwiO1xuICAgIGlmIChuZWVkc0ggJiYgY20ub3B0aW9ucy5jb3Zlckd1dHRlck5leHRUb1Njcm9sbGJhciAmJiBjbS5vcHRpb25zLmZpeGVkR3V0dGVyKSB7XG4gICAgICBkLmd1dHRlckZpbGxlci5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xuICAgICAgZC5ndXR0ZXJGaWxsZXIuc3R5bGUuaGVpZ2h0ID0gc1dpZHRoICsgXCJweFwiO1xuICAgICAgZC5ndXR0ZXJGaWxsZXIuc3R5bGUud2lkdGggPSBkLmd1dHRlcnMub2Zmc2V0V2lkdGggKyBcInB4XCI7XG4gICAgfSBlbHNlIGQuZ3V0dGVyRmlsbGVyLnN0eWxlLmRpc3BsYXkgPSBcIlwiO1xuXG4gICAgaWYgKCFjbS5zdGF0ZS5jaGVja2VkT3ZlcmxheVNjcm9sbGJhciAmJiBtZWFzdXJlLmNsaWVudEhlaWdodCA+IDApIHtcbiAgICAgIGlmIChzV2lkdGggPT09IDApIHtcbiAgICAgICAgdmFyIHcgPSBtYWMgJiYgIW1hY19nZU1vdW50YWluTGlvbiA/IFwiMTJweFwiIDogXCIxOHB4XCI7XG4gICAgICAgIGQuc2Nyb2xsYmFyVi5zdHlsZS5taW5XaWR0aCA9IGQuc2Nyb2xsYmFySC5zdHlsZS5taW5IZWlnaHQgPSB3O1xuICAgICAgICB2YXIgYmFyTW91c2VEb3duID0gZnVuY3Rpb24oZSkge1xuICAgICAgICAgIGlmIChlX3RhcmdldChlKSAhPSBkLnNjcm9sbGJhclYgJiYgZV90YXJnZXQoZSkgIT0gZC5zY3JvbGxiYXJIKVxuICAgICAgICAgICAgb3BlcmF0aW9uKGNtLCBvbk1vdXNlRG93bikoZSk7XG4gICAgICAgIH07XG4gICAgICAgIG9uKGQuc2Nyb2xsYmFyViwgXCJtb3VzZWRvd25cIiwgYmFyTW91c2VEb3duKTtcbiAgICAgICAgb24oZC5zY3JvbGxiYXJILCBcIm1vdXNlZG93blwiLCBiYXJNb3VzZURvd24pO1xuICAgICAgfVxuICAgICAgY20uc3RhdGUuY2hlY2tlZE92ZXJsYXlTY3JvbGxiYXIgPSB0cnVlO1xuICAgIH1cbiAgfVxuXG4gIC8vIENvbXB1dGUgdGhlIGxpbmVzIHRoYXQgYXJlIHZpc2libGUgaW4gYSBnaXZlbiB2aWV3cG9ydCAoZGVmYXVsdHNcbiAgLy8gdGhlIHRoZSBjdXJyZW50IHNjcm9sbCBwb3NpdGlvbikuIHZpZXdwb3J0IG1heSBjb250YWluIHRvcCxcbiAgLy8gaGVpZ2h0LCBhbmQgZW5zdXJlIChzZWUgb3Auc2Nyb2xsVG9Qb3MpIHByb3BlcnRpZXMuXG4gIGZ1bmN0aW9uIHZpc2libGVMaW5lcyhkaXNwbGF5LCBkb2MsIHZpZXdwb3J0KSB7XG4gICAgdmFyIHRvcCA9IHZpZXdwb3J0ICYmIHZpZXdwb3J0LnRvcCAhPSBudWxsID8gTWF0aC5tYXgoMCwgdmlld3BvcnQudG9wKSA6IGRpc3BsYXkuc2Nyb2xsZXIuc2Nyb2xsVG9wO1xuICAgIHRvcCA9IE1hdGguZmxvb3IodG9wIC0gcGFkZGluZ1RvcChkaXNwbGF5KSk7XG4gICAgdmFyIGJvdHRvbSA9IHZpZXdwb3J0ICYmIHZpZXdwb3J0LmJvdHRvbSAhPSBudWxsID8gdmlld3BvcnQuYm90dG9tIDogdG9wICsgZGlzcGxheS53cmFwcGVyLmNsaWVudEhlaWdodDtcblxuICAgIHZhciBmcm9tID0gbGluZUF0SGVpZ2h0KGRvYywgdG9wKSwgdG8gPSBsaW5lQXRIZWlnaHQoZG9jLCBib3R0b20pO1xuICAgIC8vIEVuc3VyZSBpcyBhIHtmcm9tOiB7bGluZSwgY2h9LCB0bzoge2xpbmUsIGNofX0gb2JqZWN0LCBhbmRcbiAgICAvLyBmb3JjZXMgdGhvc2UgbGluZXMgaW50byB0aGUgdmlld3BvcnQgKGlmIHBvc3NpYmxlKS5cbiAgICBpZiAodmlld3BvcnQgJiYgdmlld3BvcnQuZW5zdXJlKSB7XG4gICAgICB2YXIgZW5zdXJlRnJvbSA9IHZpZXdwb3J0LmVuc3VyZS5mcm9tLmxpbmUsIGVuc3VyZVRvID0gdmlld3BvcnQuZW5zdXJlLnRvLmxpbmU7XG4gICAgICBpZiAoZW5zdXJlRnJvbSA8IGZyb20pXG4gICAgICAgIHJldHVybiB7ZnJvbTogZW5zdXJlRnJvbSxcbiAgICAgICAgICAgICAgICB0bzogbGluZUF0SGVpZ2h0KGRvYywgaGVpZ2h0QXRMaW5lKGdldExpbmUoZG9jLCBlbnN1cmVGcm9tKSkgKyBkaXNwbGF5LndyYXBwZXIuY2xpZW50SGVpZ2h0KX07XG4gICAgICBpZiAoTWF0aC5taW4oZW5zdXJlVG8sIGRvYy5sYXN0TGluZSgpKSA+PSB0bylcbiAgICAgICAgcmV0dXJuIHtmcm9tOiBsaW5lQXRIZWlnaHQoZG9jLCBoZWlnaHRBdExpbmUoZ2V0TGluZShkb2MsIGVuc3VyZVRvKSkgLSBkaXNwbGF5LndyYXBwZXIuY2xpZW50SGVpZ2h0KSxcbiAgICAgICAgICAgICAgICB0bzogZW5zdXJlVG99O1xuICAgIH1cbiAgICByZXR1cm4ge2Zyb206IGZyb20sIHRvOiBNYXRoLm1heCh0bywgZnJvbSArIDEpfTtcbiAgfVxuXG4gIC8vIExJTkUgTlVNQkVSU1xuXG4gIC8vIFJlLWFsaWduIGxpbmUgbnVtYmVycyBhbmQgZ3V0dGVyIG1hcmtzIHRvIGNvbXBlbnNhdGUgZm9yXG4gIC8vIGhvcml6b250YWwgc2Nyb2xsaW5nLlxuICBmdW5jdGlvbiBhbGlnbkhvcml6b250YWxseShjbSkge1xuICAgIHZhciBkaXNwbGF5ID0gY20uZGlzcGxheSwgdmlldyA9IGRpc3BsYXkudmlldztcbiAgICBpZiAoIWRpc3BsYXkuYWxpZ25XaWRnZXRzICYmICghZGlzcGxheS5ndXR0ZXJzLmZpcnN0Q2hpbGQgfHwgIWNtLm9wdGlvbnMuZml4ZWRHdXR0ZXIpKSByZXR1cm47XG4gICAgdmFyIGNvbXAgPSBjb21wZW5zYXRlRm9ySFNjcm9sbChkaXNwbGF5KSAtIGRpc3BsYXkuc2Nyb2xsZXIuc2Nyb2xsTGVmdCArIGNtLmRvYy5zY3JvbGxMZWZ0O1xuICAgIHZhciBndXR0ZXJXID0gZGlzcGxheS5ndXR0ZXJzLm9mZnNldFdpZHRoLCBsZWZ0ID0gY29tcCArIFwicHhcIjtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHZpZXcubGVuZ3RoOyBpKyspIGlmICghdmlld1tpXS5oaWRkZW4pIHtcbiAgICAgIGlmIChjbS5vcHRpb25zLmZpeGVkR3V0dGVyICYmIHZpZXdbaV0uZ3V0dGVyKVxuICAgICAgICB2aWV3W2ldLmd1dHRlci5zdHlsZS5sZWZ0ID0gbGVmdDtcbiAgICAgIHZhciBhbGlnbiA9IHZpZXdbaV0uYWxpZ25hYmxlO1xuICAgICAgaWYgKGFsaWduKSBmb3IgKHZhciBqID0gMDsgaiA8IGFsaWduLmxlbmd0aDsgaisrKVxuICAgICAgICBhbGlnbltqXS5zdHlsZS5sZWZ0ID0gbGVmdDtcbiAgICB9XG4gICAgaWYgKGNtLm9wdGlvbnMuZml4ZWRHdXR0ZXIpXG4gICAgICBkaXNwbGF5Lmd1dHRlcnMuc3R5bGUubGVmdCA9IChjb21wICsgZ3V0dGVyVykgKyBcInB4XCI7XG4gIH1cblxuICAvLyBVc2VkIHRvIGVuc3VyZSB0aGF0IHRoZSBsaW5lIG51bWJlciBndXR0ZXIgaXMgc3RpbGwgdGhlIHJpZ2h0XG4gIC8vIHNpemUgZm9yIHRoZSBjdXJyZW50IGRvY3VtZW50IHNpemUuIFJldHVybnMgdHJ1ZSB3aGVuIGFuIHVwZGF0ZVxuICAvLyBpcyBuZWVkZWQuXG4gIGZ1bmN0aW9uIG1heWJlVXBkYXRlTGluZU51bWJlcldpZHRoKGNtKSB7XG4gICAgaWYgKCFjbS5vcHRpb25zLmxpbmVOdW1iZXJzKSByZXR1cm4gZmFsc2U7XG4gICAgdmFyIGRvYyA9IGNtLmRvYywgbGFzdCA9IGxpbmVOdW1iZXJGb3IoY20ub3B0aW9ucywgZG9jLmZpcnN0ICsgZG9jLnNpemUgLSAxKSwgZGlzcGxheSA9IGNtLmRpc3BsYXk7XG4gICAgaWYgKGxhc3QubGVuZ3RoICE9IGRpc3BsYXkubGluZU51bUNoYXJzKSB7XG4gICAgICB2YXIgdGVzdCA9IGRpc3BsYXkubWVhc3VyZS5hcHBlbmRDaGlsZChlbHQoXCJkaXZcIiwgW2VsdChcImRpdlwiLCBsYXN0KV0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJDb2RlTWlycm9yLWxpbmVudW1iZXIgQ29kZU1pcnJvci1ndXR0ZXItZWx0XCIpKTtcbiAgICAgIHZhciBpbm5lclcgPSB0ZXN0LmZpcnN0Q2hpbGQub2Zmc2V0V2lkdGgsIHBhZGRpbmcgPSB0ZXN0Lm9mZnNldFdpZHRoIC0gaW5uZXJXO1xuICAgICAgZGlzcGxheS5saW5lR3V0dGVyLnN0eWxlLndpZHRoID0gXCJcIjtcbiAgICAgIGRpc3BsYXkubGluZU51bUlubmVyV2lkdGggPSBNYXRoLm1heChpbm5lclcsIGRpc3BsYXkubGluZUd1dHRlci5vZmZzZXRXaWR0aCAtIHBhZGRpbmcpO1xuICAgICAgZGlzcGxheS5saW5lTnVtV2lkdGggPSBkaXNwbGF5LmxpbmVOdW1Jbm5lcldpZHRoICsgcGFkZGluZztcbiAgICAgIGRpc3BsYXkubGluZU51bUNoYXJzID0gZGlzcGxheS5saW5lTnVtSW5uZXJXaWR0aCA/IGxhc3QubGVuZ3RoIDogLTE7XG4gICAgICBkaXNwbGF5LmxpbmVHdXR0ZXIuc3R5bGUud2lkdGggPSBkaXNwbGF5LmxpbmVOdW1XaWR0aCArIFwicHhcIjtcbiAgICAgIHVwZGF0ZUd1dHRlclNwYWNlKGNtKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBmdW5jdGlvbiBsaW5lTnVtYmVyRm9yKG9wdGlvbnMsIGkpIHtcbiAgICByZXR1cm4gU3RyaW5nKG9wdGlvbnMubGluZU51bWJlckZvcm1hdHRlcihpICsgb3B0aW9ucy5maXJzdExpbmVOdW1iZXIpKTtcbiAgfVxuXG4gIC8vIENvbXB1dGVzIGRpc3BsYXkuc2Nyb2xsZXIuc2Nyb2xsTGVmdCArIGRpc3BsYXkuZ3V0dGVycy5vZmZzZXRXaWR0aCxcbiAgLy8gYnV0IHVzaW5nIGdldEJvdW5kaW5nQ2xpZW50UmVjdCB0byBnZXQgYSBzdWItcGl4ZWwtYWNjdXJhdGVcbiAgLy8gcmVzdWx0LlxuICBmdW5jdGlvbiBjb21wZW5zYXRlRm9ySFNjcm9sbChkaXNwbGF5KSB7XG4gICAgcmV0dXJuIGRpc3BsYXkuc2Nyb2xsZXIuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkubGVmdCAtIGRpc3BsYXkuc2l6ZXIuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkubGVmdDtcbiAgfVxuXG4gIC8vIERJU1BMQVkgRFJBV0lOR1xuXG4gIGZ1bmN0aW9uIERpc3BsYXlVcGRhdGUoY20sIHZpZXdwb3J0LCBmb3JjZSkge1xuICAgIHZhciBkaXNwbGF5ID0gY20uZGlzcGxheTtcblxuICAgIHRoaXMudmlld3BvcnQgPSB2aWV3cG9ydDtcbiAgICAvLyBTdG9yZSBzb21lIHZhbHVlcyB0aGF0IHdlJ2xsIG5lZWQgbGF0ZXIgKGJ1dCBkb24ndCB3YW50IHRvIGZvcmNlIGEgcmVsYXlvdXQgZm9yKVxuICAgIHRoaXMudmlzaWJsZSA9IHZpc2libGVMaW5lcyhkaXNwbGF5LCBjbS5kb2MsIHZpZXdwb3J0KTtcbiAgICB0aGlzLmVkaXRvcklzSGlkZGVuID0gIWRpc3BsYXkud3JhcHBlci5vZmZzZXRXaWR0aDtcbiAgICB0aGlzLndyYXBwZXJIZWlnaHQgPSBkaXNwbGF5LndyYXBwZXIuY2xpZW50SGVpZ2h0O1xuICAgIHRoaXMub2xkVmlld0Zyb20gPSBkaXNwbGF5LnZpZXdGcm9tOyB0aGlzLm9sZFZpZXdUbyA9IGRpc3BsYXkudmlld1RvO1xuICAgIHRoaXMub2xkU2Nyb2xsZXJXaWR0aCA9IGRpc3BsYXkuc2Nyb2xsZXIuY2xpZW50V2lkdGg7XG4gICAgdGhpcy5mb3JjZSA9IGZvcmNlO1xuICAgIHRoaXMuZGltcyA9IGdldERpbWVuc2lvbnMoY20pO1xuICB9XG5cbiAgLy8gRG9lcyB0aGUgYWN0dWFsIHVwZGF0aW5nIG9mIHRoZSBsaW5lIGRpc3BsYXkuIEJhaWxzIG91dFxuICAvLyAocmV0dXJuaW5nIGZhbHNlKSB3aGVuIHRoZXJlIGlzIG5vdGhpbmcgdG8gYmUgZG9uZSBhbmQgZm9yY2VkIGlzXG4gIC8vIGZhbHNlLlxuICBmdW5jdGlvbiB1cGRhdGVEaXNwbGF5SWZOZWVkZWQoY20sIHVwZGF0ZSkge1xuICAgIHZhciBkaXNwbGF5ID0gY20uZGlzcGxheSwgZG9jID0gY20uZG9jO1xuICAgIGlmICh1cGRhdGUuZWRpdG9ySXNIaWRkZW4pIHtcbiAgICAgIHJlc2V0VmlldyhjbSk7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgLy8gQmFpbCBvdXQgaWYgdGhlIHZpc2libGUgYXJlYSBpcyBhbHJlYWR5IHJlbmRlcmVkIGFuZCBub3RoaW5nIGNoYW5nZWQuXG4gICAgaWYgKCF1cGRhdGUuZm9yY2UgJiZcbiAgICAgICAgdXBkYXRlLnZpc2libGUuZnJvbSA+PSBkaXNwbGF5LnZpZXdGcm9tICYmIHVwZGF0ZS52aXNpYmxlLnRvIDw9IGRpc3BsYXkudmlld1RvICYmXG4gICAgICAgIChkaXNwbGF5LnVwZGF0ZUxpbmVOdW1iZXJzID09IG51bGwgfHwgZGlzcGxheS51cGRhdGVMaW5lTnVtYmVycyA+PSBkaXNwbGF5LnZpZXdUbykgJiZcbiAgICAgICAgY291bnREaXJ0eVZpZXcoY20pID09IDApXG4gICAgICByZXR1cm4gZmFsc2U7XG5cbiAgICBpZiAobWF5YmVVcGRhdGVMaW5lTnVtYmVyV2lkdGgoY20pKSB7XG4gICAgICByZXNldFZpZXcoY20pO1xuICAgICAgdXBkYXRlLmRpbXMgPSBnZXREaW1lbnNpb25zKGNtKTtcbiAgICB9XG5cbiAgICAvLyBDb21wdXRlIGEgc3VpdGFibGUgbmV3IHZpZXdwb3J0IChmcm9tICYgdG8pXG4gICAgdmFyIGVuZCA9IGRvYy5maXJzdCArIGRvYy5zaXplO1xuICAgIHZhciBmcm9tID0gTWF0aC5tYXgodXBkYXRlLnZpc2libGUuZnJvbSAtIGNtLm9wdGlvbnMudmlld3BvcnRNYXJnaW4sIGRvYy5maXJzdCk7XG4gICAgdmFyIHRvID0gTWF0aC5taW4oZW5kLCB1cGRhdGUudmlzaWJsZS50byArIGNtLm9wdGlvbnMudmlld3BvcnRNYXJnaW4pO1xuICAgIGlmIChkaXNwbGF5LnZpZXdGcm9tIDwgZnJvbSAmJiBmcm9tIC0gZGlzcGxheS52aWV3RnJvbSA8IDIwKSBmcm9tID0gTWF0aC5tYXgoZG9jLmZpcnN0LCBkaXNwbGF5LnZpZXdGcm9tKTtcbiAgICBpZiAoZGlzcGxheS52aWV3VG8gPiB0byAmJiBkaXNwbGF5LnZpZXdUbyAtIHRvIDwgMjApIHRvID0gTWF0aC5taW4oZW5kLCBkaXNwbGF5LnZpZXdUbyk7XG4gICAgaWYgKHNhd0NvbGxhcHNlZFNwYW5zKSB7XG4gICAgICBmcm9tID0gdmlzdWFsTGluZU5vKGNtLmRvYywgZnJvbSk7XG4gICAgICB0byA9IHZpc3VhbExpbmVFbmRObyhjbS5kb2MsIHRvKTtcbiAgICB9XG5cbiAgICB2YXIgZGlmZmVyZW50ID0gZnJvbSAhPSBkaXNwbGF5LnZpZXdGcm9tIHx8IHRvICE9IGRpc3BsYXkudmlld1RvIHx8XG4gICAgICBkaXNwbGF5Lmxhc3RTaXplQyAhPSB1cGRhdGUud3JhcHBlckhlaWdodDtcbiAgICBhZGp1c3RWaWV3KGNtLCBmcm9tLCB0byk7XG5cbiAgICBkaXNwbGF5LnZpZXdPZmZzZXQgPSBoZWlnaHRBdExpbmUoZ2V0TGluZShjbS5kb2MsIGRpc3BsYXkudmlld0Zyb20pKTtcbiAgICAvLyBQb3NpdGlvbiB0aGUgbW92ZXIgZGl2IHRvIGFsaWduIHdpdGggdGhlIGN1cnJlbnQgc2Nyb2xsIHBvc2l0aW9uXG4gICAgY20uZGlzcGxheS5tb3Zlci5zdHlsZS50b3AgPSBkaXNwbGF5LnZpZXdPZmZzZXQgKyBcInB4XCI7XG5cbiAgICB2YXIgdG9VcGRhdGUgPSBjb3VudERpcnR5VmlldyhjbSk7XG4gICAgaWYgKCFkaWZmZXJlbnQgJiYgdG9VcGRhdGUgPT0gMCAmJiAhdXBkYXRlLmZvcmNlICYmXG4gICAgICAgIChkaXNwbGF5LnVwZGF0ZUxpbmVOdW1iZXJzID09IG51bGwgfHwgZGlzcGxheS51cGRhdGVMaW5lTnVtYmVycyA+PSBkaXNwbGF5LnZpZXdUbykpXG4gICAgICByZXR1cm4gZmFsc2U7XG5cbiAgICAvLyBGb3IgYmlnIGNoYW5nZXMsIHdlIGhpZGUgdGhlIGVuY2xvc2luZyBlbGVtZW50IGR1cmluZyB0aGVcbiAgICAvLyB1cGRhdGUsIHNpbmNlIHRoYXQgc3BlZWRzIHVwIHRoZSBvcGVyYXRpb25zIG9uIG1vc3QgYnJvd3NlcnMuXG4gICAgdmFyIGZvY3VzZWQgPSBhY3RpdmVFbHQoKTtcbiAgICBpZiAodG9VcGRhdGUgPiA0KSBkaXNwbGF5LmxpbmVEaXYuc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICAgIHBhdGNoRGlzcGxheShjbSwgZGlzcGxheS51cGRhdGVMaW5lTnVtYmVycywgdXBkYXRlLmRpbXMpO1xuICAgIGlmICh0b1VwZGF0ZSA+IDQpIGRpc3BsYXkubGluZURpdi5zdHlsZS5kaXNwbGF5ID0gXCJcIjtcbiAgICAvLyBUaGVyZSBtaWdodCBoYXZlIGJlZW4gYSB3aWRnZXQgd2l0aCBhIGZvY3VzZWQgZWxlbWVudCB0aGF0IGdvdFxuICAgIC8vIGhpZGRlbiBvciB1cGRhdGVkLCBpZiBzbyByZS1mb2N1cyBpdC5cbiAgICBpZiAoZm9jdXNlZCAmJiBhY3RpdmVFbHQoKSAhPSBmb2N1c2VkICYmIGZvY3VzZWQub2Zmc2V0SGVpZ2h0KSBmb2N1c2VkLmZvY3VzKCk7XG5cbiAgICAvLyBQcmV2ZW50IHNlbGVjdGlvbiBhbmQgY3Vyc29ycyBmcm9tIGludGVyZmVyaW5nIHdpdGggdGhlIHNjcm9sbFxuICAgIC8vIHdpZHRoLlxuICAgIHJlbW92ZUNoaWxkcmVuKGRpc3BsYXkuY3Vyc29yRGl2KTtcbiAgICByZW1vdmVDaGlsZHJlbihkaXNwbGF5LnNlbGVjdGlvbkRpdik7XG5cbiAgICBpZiAoZGlmZmVyZW50KSB7XG4gICAgICBkaXNwbGF5Lmxhc3RTaXplQyA9IHVwZGF0ZS53cmFwcGVySGVpZ2h0O1xuICAgICAgc3RhcnRXb3JrZXIoY20sIDQwMCk7XG4gICAgfVxuXG4gICAgZGlzcGxheS51cGRhdGVMaW5lTnVtYmVycyA9IG51bGw7XG5cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHBvc3RVcGRhdGVEaXNwbGF5KGNtLCB1cGRhdGUpIHtcbiAgICB2YXIgZm9yY2UgPSB1cGRhdGUuZm9yY2UsIHZpZXdwb3J0ID0gdXBkYXRlLnZpZXdwb3J0O1xuICAgIGZvciAodmFyIGZpcnN0ID0gdHJ1ZTs7IGZpcnN0ID0gZmFsc2UpIHtcbiAgICAgIGlmIChmaXJzdCAmJiBjbS5vcHRpb25zLmxpbmVXcmFwcGluZyAmJiB1cGRhdGUub2xkU2Nyb2xsZXJXaWR0aCAhPSBjbS5kaXNwbGF5LnNjcm9sbGVyLmNsaWVudFdpZHRoKSB7XG4gICAgICAgIGZvcmNlID0gdHJ1ZTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGZvcmNlID0gZmFsc2U7XG4gICAgICAgIC8vIENsaXAgZm9yY2VkIHZpZXdwb3J0IHRvIGFjdHVhbCBzY3JvbGxhYmxlIGFyZWEuXG4gICAgICAgIGlmICh2aWV3cG9ydCAmJiB2aWV3cG9ydC50b3AgIT0gbnVsbClcbiAgICAgICAgICB2aWV3cG9ydCA9IHt0b3A6IE1hdGgubWluKGNtLmRvYy5oZWlnaHQgKyBwYWRkaW5nVmVydChjbS5kaXNwbGF5KSAtIHNjcm9sbGVyQ3V0T2ZmIC1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNtLmRpc3BsYXkuc2Nyb2xsZXIuY2xpZW50SGVpZ2h0LCB2aWV3cG9ydC50b3ApfTtcbiAgICAgICAgLy8gVXBkYXRlZCBsaW5lIGhlaWdodHMgbWlnaHQgcmVzdWx0IGluIHRoZSBkcmF3biBhcmVhIG5vdFxuICAgICAgICAvLyBhY3R1YWxseSBjb3ZlcmluZyB0aGUgdmlld3BvcnQuIEtlZXAgbG9vcGluZyB1bnRpbCBpdCBkb2VzLlxuICAgICAgICB1cGRhdGUudmlzaWJsZSA9IHZpc2libGVMaW5lcyhjbS5kaXNwbGF5LCBjbS5kb2MsIHZpZXdwb3J0KTtcbiAgICAgICAgaWYgKHVwZGF0ZS52aXNpYmxlLmZyb20gPj0gY20uZGlzcGxheS52aWV3RnJvbSAmJiB1cGRhdGUudmlzaWJsZS50byA8PSBjbS5kaXNwbGF5LnZpZXdUbylcbiAgICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGlmICghdXBkYXRlRGlzcGxheUlmTmVlZGVkKGNtLCB1cGRhdGUpKSBicmVhaztcbiAgICAgIHVwZGF0ZUhlaWdodHNJblZpZXdwb3J0KGNtKTtcbiAgICAgIHZhciBiYXJNZWFzdXJlID0gbWVhc3VyZUZvclNjcm9sbGJhcnMoY20pO1xuICAgICAgdXBkYXRlU2VsZWN0aW9uKGNtKTtcbiAgICAgIHNldERvY3VtZW50SGVpZ2h0KGNtLCBiYXJNZWFzdXJlKTtcbiAgICAgIHVwZGF0ZVNjcm9sbGJhcnMoY20sIGJhck1lYXN1cmUpO1xuICAgIH1cblxuICAgIHNpZ25hbExhdGVyKGNtLCBcInVwZGF0ZVwiLCBjbSk7XG4gICAgaWYgKGNtLmRpc3BsYXkudmlld0Zyb20gIT0gdXBkYXRlLm9sZFZpZXdGcm9tIHx8IGNtLmRpc3BsYXkudmlld1RvICE9IHVwZGF0ZS5vbGRWaWV3VG8pXG4gICAgICBzaWduYWxMYXRlcihjbSwgXCJ2aWV3cG9ydENoYW5nZVwiLCBjbSwgY20uZGlzcGxheS52aWV3RnJvbSwgY20uZGlzcGxheS52aWV3VG8pO1xuICB9XG5cbiAgZnVuY3Rpb24gdXBkYXRlRGlzcGxheVNpbXBsZShjbSwgdmlld3BvcnQpIHtcbiAgICB2YXIgdXBkYXRlID0gbmV3IERpc3BsYXlVcGRhdGUoY20sIHZpZXdwb3J0KTtcbiAgICBpZiAodXBkYXRlRGlzcGxheUlmTmVlZGVkKGNtLCB1cGRhdGUpKSB7XG4gICAgICBwb3N0VXBkYXRlRGlzcGxheShjbSwgdXBkYXRlKTtcbiAgICAgIHZhciBiYXJNZWFzdXJlID0gbWVhc3VyZUZvclNjcm9sbGJhcnMoY20pO1xuICAgICAgdXBkYXRlU2VsZWN0aW9uKGNtKTtcbiAgICAgIHNldERvY3VtZW50SGVpZ2h0KGNtLCBiYXJNZWFzdXJlKTtcbiAgICAgIHVwZGF0ZVNjcm9sbGJhcnMoY20sIGJhck1lYXN1cmUpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHNldERvY3VtZW50SGVpZ2h0KGNtLCBtZWFzdXJlKSB7XG4gICAgY20uZGlzcGxheS5zaXplci5zdHlsZS5taW5IZWlnaHQgPSBjbS5kaXNwbGF5LmhlaWdodEZvcmNlci5zdHlsZS50b3AgPSBtZWFzdXJlLmRvY0hlaWdodCArIFwicHhcIjtcbiAgICBjbS5kaXNwbGF5Lmd1dHRlcnMuc3R5bGUuaGVpZ2h0ID0gTWF0aC5tYXgobWVhc3VyZS5kb2NIZWlnaHQsIG1lYXN1cmUuY2xpZW50SGVpZ2h0IC0gc2Nyb2xsZXJDdXRPZmYpICsgXCJweFwiO1xuICB9XG5cbiAgZnVuY3Rpb24gY2hlY2tGb3JXZWJraXRXaWR0aEJ1ZyhjbSwgbWVhc3VyZSkge1xuICAgIC8vIFdvcmsgYXJvdW5kIFdlYmtpdCBidWcgd2hlcmUgaXQgc29tZXRpbWVzIHJlc2VydmVzIHNwYWNlIGZvciBhXG4gICAgLy8gbm9uLWV4aXN0aW5nIHBoYW50b20gc2Nyb2xsYmFyIGluIHRoZSBzY3JvbGxlciAoSXNzdWUgIzI0MjApXG4gICAgaWYgKGNtLmRpc3BsYXkuc2l6ZXIub2Zmc2V0V2lkdGggKyBjbS5kaXNwbGF5Lmd1dHRlcnMub2Zmc2V0V2lkdGggPCBjbS5kaXNwbGF5LnNjcm9sbGVyLmNsaWVudFdpZHRoIC0gMSkge1xuICAgICAgY20uZGlzcGxheS5zaXplci5zdHlsZS5taW5IZWlnaHQgPSBjbS5kaXNwbGF5LmhlaWdodEZvcmNlci5zdHlsZS50b3AgPSBcIjBweFwiO1xuICAgICAgY20uZGlzcGxheS5ndXR0ZXJzLnN0eWxlLmhlaWdodCA9IG1lYXN1cmUuZG9jSGVpZ2h0ICsgXCJweFwiO1xuICAgIH1cbiAgfVxuXG4gIC8vIFJlYWQgdGhlIGFjdHVhbCBoZWlnaHRzIG9mIHRoZSByZW5kZXJlZCBsaW5lcywgYW5kIHVwZGF0ZSB0aGVpclxuICAvLyBzdG9yZWQgaGVpZ2h0cyB0byBtYXRjaC5cbiAgZnVuY3Rpb24gdXBkYXRlSGVpZ2h0c0luVmlld3BvcnQoY20pIHtcbiAgICB2YXIgZGlzcGxheSA9IGNtLmRpc3BsYXk7XG4gICAgdmFyIHByZXZCb3R0b20gPSBkaXNwbGF5LmxpbmVEaXYub2Zmc2V0VG9wO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZGlzcGxheS52aWV3Lmxlbmd0aDsgaSsrKSB7XG4gICAgICB2YXIgY3VyID0gZGlzcGxheS52aWV3W2ldLCBoZWlnaHQ7XG4gICAgICBpZiAoY3VyLmhpZGRlbikgY29udGludWU7XG4gICAgICBpZiAoaWUgJiYgaWVfdmVyc2lvbiA8IDgpIHtcbiAgICAgICAgdmFyIGJvdCA9IGN1ci5ub2RlLm9mZnNldFRvcCArIGN1ci5ub2RlLm9mZnNldEhlaWdodDtcbiAgICAgICAgaGVpZ2h0ID0gYm90IC0gcHJldkJvdHRvbTtcbiAgICAgICAgcHJldkJvdHRvbSA9IGJvdDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHZhciBib3ggPSBjdXIubm9kZS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgICAgaGVpZ2h0ID0gYm94LmJvdHRvbSAtIGJveC50b3A7XG4gICAgICB9XG4gICAgICB2YXIgZGlmZiA9IGN1ci5saW5lLmhlaWdodCAtIGhlaWdodDtcbiAgICAgIGlmIChoZWlnaHQgPCAyKSBoZWlnaHQgPSB0ZXh0SGVpZ2h0KGRpc3BsYXkpO1xuICAgICAgaWYgKGRpZmYgPiAuMDAxIHx8IGRpZmYgPCAtLjAwMSkge1xuICAgICAgICB1cGRhdGVMaW5lSGVpZ2h0KGN1ci5saW5lLCBoZWlnaHQpO1xuICAgICAgICB1cGRhdGVXaWRnZXRIZWlnaHQoY3VyLmxpbmUpO1xuICAgICAgICBpZiAoY3VyLnJlc3QpIGZvciAodmFyIGogPSAwOyBqIDwgY3VyLnJlc3QubGVuZ3RoOyBqKyspXG4gICAgICAgICAgdXBkYXRlV2lkZ2V0SGVpZ2h0KGN1ci5yZXN0W2pdKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBSZWFkIGFuZCBzdG9yZSB0aGUgaGVpZ2h0IG9mIGxpbmUgd2lkZ2V0cyBhc3NvY2lhdGVkIHdpdGggdGhlXG4gIC8vIGdpdmVuIGxpbmUuXG4gIGZ1bmN0aW9uIHVwZGF0ZVdpZGdldEhlaWdodChsaW5lKSB7XG4gICAgaWYgKGxpbmUud2lkZ2V0cykgZm9yICh2YXIgaSA9IDA7IGkgPCBsaW5lLndpZGdldHMubGVuZ3RoOyArK2kpXG4gICAgICBsaW5lLndpZGdldHNbaV0uaGVpZ2h0ID0gbGluZS53aWRnZXRzW2ldLm5vZGUub2Zmc2V0SGVpZ2h0O1xuICB9XG5cbiAgLy8gRG8gYSBidWxrLXJlYWQgb2YgdGhlIERPTSBwb3NpdGlvbnMgYW5kIHNpemVzIG5lZWRlZCB0byBkcmF3IHRoZVxuICAvLyB2aWV3LCBzbyB0aGF0IHdlIGRvbid0IGludGVybGVhdmUgcmVhZGluZyBhbmQgd3JpdGluZyB0byB0aGUgRE9NLlxuICBmdW5jdGlvbiBnZXREaW1lbnNpb25zKGNtKSB7XG4gICAgdmFyIGQgPSBjbS5kaXNwbGF5LCBsZWZ0ID0ge30sIHdpZHRoID0ge307XG4gICAgZm9yICh2YXIgbiA9IGQuZ3V0dGVycy5maXJzdENoaWxkLCBpID0gMDsgbjsgbiA9IG4ubmV4dFNpYmxpbmcsICsraSkge1xuICAgICAgbGVmdFtjbS5vcHRpb25zLmd1dHRlcnNbaV1dID0gbi5vZmZzZXRMZWZ0O1xuICAgICAgd2lkdGhbY20ub3B0aW9ucy5ndXR0ZXJzW2ldXSA9IG4ub2Zmc2V0V2lkdGg7XG4gICAgfVxuICAgIHJldHVybiB7Zml4ZWRQb3M6IGNvbXBlbnNhdGVGb3JIU2Nyb2xsKGQpLFxuICAgICAgICAgICAgZ3V0dGVyVG90YWxXaWR0aDogZC5ndXR0ZXJzLm9mZnNldFdpZHRoLFxuICAgICAgICAgICAgZ3V0dGVyTGVmdDogbGVmdCxcbiAgICAgICAgICAgIGd1dHRlcldpZHRoOiB3aWR0aCxcbiAgICAgICAgICAgIHdyYXBwZXJXaWR0aDogZC53cmFwcGVyLmNsaWVudFdpZHRofTtcbiAgfVxuXG4gIC8vIFN5bmMgdGhlIGFjdHVhbCBkaXNwbGF5IERPTSBzdHJ1Y3R1cmUgd2l0aCBkaXNwbGF5LnZpZXcsIHJlbW92aW5nXG4gIC8vIG5vZGVzIGZvciBsaW5lcyB0aGF0IGFyZSBubyBsb25nZXIgaW4gdmlldywgYW5kIGNyZWF0aW5nIHRoZSBvbmVzXG4gIC8vIHRoYXQgYXJlIG5vdCB0aGVyZSB5ZXQsIGFuZCB1cGRhdGluZyB0aGUgb25lcyB0aGF0IGFyZSBvdXQgb2ZcbiAgLy8gZGF0ZS5cbiAgZnVuY3Rpb24gcGF0Y2hEaXNwbGF5KGNtLCB1cGRhdGVOdW1iZXJzRnJvbSwgZGltcykge1xuICAgIHZhciBkaXNwbGF5ID0gY20uZGlzcGxheSwgbGluZU51bWJlcnMgPSBjbS5vcHRpb25zLmxpbmVOdW1iZXJzO1xuICAgIHZhciBjb250YWluZXIgPSBkaXNwbGF5LmxpbmVEaXYsIGN1ciA9IGNvbnRhaW5lci5maXJzdENoaWxkO1xuXG4gICAgZnVuY3Rpb24gcm0obm9kZSkge1xuICAgICAgdmFyIG5leHQgPSBub2RlLm5leHRTaWJsaW5nO1xuICAgICAgLy8gV29ya3MgYXJvdW5kIGEgdGhyb3ctc2Nyb2xsIGJ1ZyBpbiBPUyBYIFdlYmtpdFxuICAgICAgaWYgKHdlYmtpdCAmJiBtYWMgJiYgY20uZGlzcGxheS5jdXJyZW50V2hlZWxUYXJnZXQgPT0gbm9kZSlcbiAgICAgICAgbm9kZS5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gICAgICBlbHNlXG4gICAgICAgIG5vZGUucGFyZW50Tm9kZS5yZW1vdmVDaGlsZChub2RlKTtcbiAgICAgIHJldHVybiBuZXh0O1xuICAgIH1cblxuICAgIHZhciB2aWV3ID0gZGlzcGxheS52aWV3LCBsaW5lTiA9IGRpc3BsYXkudmlld0Zyb207XG4gICAgLy8gTG9vcCBvdmVyIHRoZSBlbGVtZW50cyBpbiB0aGUgdmlldywgc3luY2luZyBjdXIgKHRoZSBET00gbm9kZXNcbiAgICAvLyBpbiBkaXNwbGF5LmxpbmVEaXYpIHdpdGggdGhlIHZpZXcgYXMgd2UgZ28uXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCB2aWV3Lmxlbmd0aDsgaSsrKSB7XG4gICAgICB2YXIgbGluZVZpZXcgPSB2aWV3W2ldO1xuICAgICAgaWYgKGxpbmVWaWV3LmhpZGRlbikge1xuICAgICAgfSBlbHNlIGlmICghbGluZVZpZXcubm9kZSkgeyAvLyBOb3QgZHJhd24geWV0XG4gICAgICAgIHZhciBub2RlID0gYnVpbGRMaW5lRWxlbWVudChjbSwgbGluZVZpZXcsIGxpbmVOLCBkaW1zKTtcbiAgICAgICAgY29udGFpbmVyLmluc2VydEJlZm9yZShub2RlLCBjdXIpO1xuICAgICAgfSBlbHNlIHsgLy8gQWxyZWFkeSBkcmF3blxuICAgICAgICB3aGlsZSAoY3VyICE9IGxpbmVWaWV3Lm5vZGUpIGN1ciA9IHJtKGN1cik7XG4gICAgICAgIHZhciB1cGRhdGVOdW1iZXIgPSBsaW5lTnVtYmVycyAmJiB1cGRhdGVOdW1iZXJzRnJvbSAhPSBudWxsICYmXG4gICAgICAgICAgdXBkYXRlTnVtYmVyc0Zyb20gPD0gbGluZU4gJiYgbGluZVZpZXcubGluZU51bWJlcjtcbiAgICAgICAgaWYgKGxpbmVWaWV3LmNoYW5nZXMpIHtcbiAgICAgICAgICBpZiAoaW5kZXhPZihsaW5lVmlldy5jaGFuZ2VzLCBcImd1dHRlclwiKSA+IC0xKSB1cGRhdGVOdW1iZXIgPSBmYWxzZTtcbiAgICAgICAgICB1cGRhdGVMaW5lRm9yQ2hhbmdlcyhjbSwgbGluZVZpZXcsIGxpbmVOLCBkaW1zKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAodXBkYXRlTnVtYmVyKSB7XG4gICAgICAgICAgcmVtb3ZlQ2hpbGRyZW4obGluZVZpZXcubGluZU51bWJlcik7XG4gICAgICAgICAgbGluZVZpZXcubGluZU51bWJlci5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZShsaW5lTnVtYmVyRm9yKGNtLm9wdGlvbnMsIGxpbmVOKSkpO1xuICAgICAgICB9XG4gICAgICAgIGN1ciA9IGxpbmVWaWV3Lm5vZGUubmV4dFNpYmxpbmc7XG4gICAgICB9XG4gICAgICBsaW5lTiArPSBsaW5lVmlldy5zaXplO1xuICAgIH1cbiAgICB3aGlsZSAoY3VyKSBjdXIgPSBybShjdXIpO1xuICB9XG5cbiAgLy8gV2hlbiBhbiBhc3BlY3Qgb2YgYSBsaW5lIGNoYW5nZXMsIGEgc3RyaW5nIGlzIGFkZGVkIHRvXG4gIC8vIGxpbmVWaWV3LmNoYW5nZXMuIFRoaXMgdXBkYXRlcyB0aGUgcmVsZXZhbnQgcGFydCBvZiB0aGUgbGluZSdzXG4gIC8vIERPTSBzdHJ1Y3R1cmUuXG4gIGZ1bmN0aW9uIHVwZGF0ZUxpbmVGb3JDaGFuZ2VzKGNtLCBsaW5lVmlldywgbGluZU4sIGRpbXMpIHtcbiAgICBmb3IgKHZhciBqID0gMDsgaiA8IGxpbmVWaWV3LmNoYW5nZXMubGVuZ3RoOyBqKyspIHtcbiAgICAgIHZhciB0eXBlID0gbGluZVZpZXcuY2hhbmdlc1tqXTtcbiAgICAgIGlmICh0eXBlID09IFwidGV4dFwiKSB1cGRhdGVMaW5lVGV4dChjbSwgbGluZVZpZXcpO1xuICAgICAgZWxzZSBpZiAodHlwZSA9PSBcImd1dHRlclwiKSB1cGRhdGVMaW5lR3V0dGVyKGNtLCBsaW5lVmlldywgbGluZU4sIGRpbXMpO1xuICAgICAgZWxzZSBpZiAodHlwZSA9PSBcImNsYXNzXCIpIHVwZGF0ZUxpbmVDbGFzc2VzKGxpbmVWaWV3KTtcbiAgICAgIGVsc2UgaWYgKHR5cGUgPT0gXCJ3aWRnZXRcIikgdXBkYXRlTGluZVdpZGdldHMobGluZVZpZXcsIGRpbXMpO1xuICAgIH1cbiAgICBsaW5lVmlldy5jaGFuZ2VzID0gbnVsbDtcbiAgfVxuXG4gIC8vIExpbmVzIHdpdGggZ3V0dGVyIGVsZW1lbnRzLCB3aWRnZXRzIG9yIGEgYmFja2dyb3VuZCBjbGFzcyBuZWVkIHRvXG4gIC8vIGJlIHdyYXBwZWQsIGFuZCBoYXZlIHRoZSBleHRyYSBlbGVtZW50cyBhZGRlZCB0byB0aGUgd3JhcHBlciBkaXZcbiAgZnVuY3Rpb24gZW5zdXJlTGluZVdyYXBwZWQobGluZVZpZXcpIHtcbiAgICBpZiAobGluZVZpZXcubm9kZSA9PSBsaW5lVmlldy50ZXh0KSB7XG4gICAgICBsaW5lVmlldy5ub2RlID0gZWx0KFwiZGl2XCIsIG51bGwsIG51bGwsIFwicG9zaXRpb246IHJlbGF0aXZlXCIpO1xuICAgICAgaWYgKGxpbmVWaWV3LnRleHQucGFyZW50Tm9kZSlcbiAgICAgICAgbGluZVZpZXcudGV4dC5wYXJlbnROb2RlLnJlcGxhY2VDaGlsZChsaW5lVmlldy5ub2RlLCBsaW5lVmlldy50ZXh0KTtcbiAgICAgIGxpbmVWaWV3Lm5vZGUuYXBwZW5kQ2hpbGQobGluZVZpZXcudGV4dCk7XG4gICAgICBpZiAoaWUgJiYgaWVfdmVyc2lvbiA8IDgpIGxpbmVWaWV3Lm5vZGUuc3R5bGUuekluZGV4ID0gMjtcbiAgICB9XG4gICAgcmV0dXJuIGxpbmVWaWV3Lm5vZGU7XG4gIH1cblxuICBmdW5jdGlvbiB1cGRhdGVMaW5lQmFja2dyb3VuZChsaW5lVmlldykge1xuICAgIHZhciBjbHMgPSBsaW5lVmlldy5iZ0NsYXNzID8gbGluZVZpZXcuYmdDbGFzcyArIFwiIFwiICsgKGxpbmVWaWV3LmxpbmUuYmdDbGFzcyB8fCBcIlwiKSA6IGxpbmVWaWV3LmxpbmUuYmdDbGFzcztcbiAgICBpZiAoY2xzKSBjbHMgKz0gXCIgQ29kZU1pcnJvci1saW5lYmFja2dyb3VuZFwiO1xuICAgIGlmIChsaW5lVmlldy5iYWNrZ3JvdW5kKSB7XG4gICAgICBpZiAoY2xzKSBsaW5lVmlldy5iYWNrZ3JvdW5kLmNsYXNzTmFtZSA9IGNscztcbiAgICAgIGVsc2UgeyBsaW5lVmlldy5iYWNrZ3JvdW5kLnBhcmVudE5vZGUucmVtb3ZlQ2hpbGQobGluZVZpZXcuYmFja2dyb3VuZCk7IGxpbmVWaWV3LmJhY2tncm91bmQgPSBudWxsOyB9XG4gICAgfSBlbHNlIGlmIChjbHMpIHtcbiAgICAgIHZhciB3cmFwID0gZW5zdXJlTGluZVdyYXBwZWQobGluZVZpZXcpO1xuICAgICAgbGluZVZpZXcuYmFja2dyb3VuZCA9IHdyYXAuaW5zZXJ0QmVmb3JlKGVsdChcImRpdlwiLCBudWxsLCBjbHMpLCB3cmFwLmZpcnN0Q2hpbGQpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFdyYXBwZXIgYXJvdW5kIGJ1aWxkTGluZUNvbnRlbnQgd2hpY2ggd2lsbCByZXVzZSB0aGUgc3RydWN0dXJlXG4gIC8vIGluIGRpc3BsYXkuZXh0ZXJuYWxNZWFzdXJlZCB3aGVuIHBvc3NpYmxlLlxuICBmdW5jdGlvbiBnZXRMaW5lQ29udGVudChjbSwgbGluZVZpZXcpIHtcbiAgICB2YXIgZXh0ID0gY20uZGlzcGxheS5leHRlcm5hbE1lYXN1cmVkO1xuICAgIGlmIChleHQgJiYgZXh0LmxpbmUgPT0gbGluZVZpZXcubGluZSkge1xuICAgICAgY20uZGlzcGxheS5leHRlcm5hbE1lYXN1cmVkID0gbnVsbDtcbiAgICAgIGxpbmVWaWV3Lm1lYXN1cmUgPSBleHQubWVhc3VyZTtcbiAgICAgIHJldHVybiBleHQuYnVpbHQ7XG4gICAgfVxuICAgIHJldHVybiBidWlsZExpbmVDb250ZW50KGNtLCBsaW5lVmlldyk7XG4gIH1cblxuICAvLyBSZWRyYXcgdGhlIGxpbmUncyB0ZXh0LiBJbnRlcmFjdHMgd2l0aCB0aGUgYmFja2dyb3VuZCBhbmQgdGV4dFxuICAvLyBjbGFzc2VzIGJlY2F1c2UgdGhlIG1vZGUgbWF5IG91dHB1dCB0b2tlbnMgdGhhdCBpbmZsdWVuY2UgdGhlc2VcbiAgLy8gY2xhc3Nlcy5cbiAgZnVuY3Rpb24gdXBkYXRlTGluZVRleHQoY20sIGxpbmVWaWV3KSB7XG4gICAgdmFyIGNscyA9IGxpbmVWaWV3LnRleHQuY2xhc3NOYW1lO1xuICAgIHZhciBidWlsdCA9IGdldExpbmVDb250ZW50KGNtLCBsaW5lVmlldyk7XG4gICAgaWYgKGxpbmVWaWV3LnRleHQgPT0gbGluZVZpZXcubm9kZSkgbGluZVZpZXcubm9kZSA9IGJ1aWx0LnByZTtcbiAgICBsaW5lVmlldy50ZXh0LnBhcmVudE5vZGUucmVwbGFjZUNoaWxkKGJ1aWx0LnByZSwgbGluZVZpZXcudGV4dCk7XG4gICAgbGluZVZpZXcudGV4dCA9IGJ1aWx0LnByZTtcbiAgICBpZiAoYnVpbHQuYmdDbGFzcyAhPSBsaW5lVmlldy5iZ0NsYXNzIHx8IGJ1aWx0LnRleHRDbGFzcyAhPSBsaW5lVmlldy50ZXh0Q2xhc3MpIHtcbiAgICAgIGxpbmVWaWV3LmJnQ2xhc3MgPSBidWlsdC5iZ0NsYXNzO1xuICAgICAgbGluZVZpZXcudGV4dENsYXNzID0gYnVpbHQudGV4dENsYXNzO1xuICAgICAgdXBkYXRlTGluZUNsYXNzZXMobGluZVZpZXcpO1xuICAgIH0gZWxzZSBpZiAoY2xzKSB7XG4gICAgICBsaW5lVmlldy50ZXh0LmNsYXNzTmFtZSA9IGNscztcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiB1cGRhdGVMaW5lQ2xhc3NlcyhsaW5lVmlldykge1xuICAgIHVwZGF0ZUxpbmVCYWNrZ3JvdW5kKGxpbmVWaWV3KTtcbiAgICBpZiAobGluZVZpZXcubGluZS53cmFwQ2xhc3MpXG4gICAgICBlbnN1cmVMaW5lV3JhcHBlZChsaW5lVmlldykuY2xhc3NOYW1lID0gbGluZVZpZXcubGluZS53cmFwQ2xhc3M7XG4gICAgZWxzZSBpZiAobGluZVZpZXcubm9kZSAhPSBsaW5lVmlldy50ZXh0KVxuICAgICAgbGluZVZpZXcubm9kZS5jbGFzc05hbWUgPSBcIlwiO1xuICAgIHZhciB0ZXh0Q2xhc3MgPSBsaW5lVmlldy50ZXh0Q2xhc3MgPyBsaW5lVmlldy50ZXh0Q2xhc3MgKyBcIiBcIiArIChsaW5lVmlldy5saW5lLnRleHRDbGFzcyB8fCBcIlwiKSA6IGxpbmVWaWV3LmxpbmUudGV4dENsYXNzO1xuICAgIGxpbmVWaWV3LnRleHQuY2xhc3NOYW1lID0gdGV4dENsYXNzIHx8IFwiXCI7XG4gIH1cblxuICBmdW5jdGlvbiB1cGRhdGVMaW5lR3V0dGVyKGNtLCBsaW5lVmlldywgbGluZU4sIGRpbXMpIHtcbiAgICBpZiAobGluZVZpZXcuZ3V0dGVyKSB7XG4gICAgICBsaW5lVmlldy5ub2RlLnJlbW92ZUNoaWxkKGxpbmVWaWV3Lmd1dHRlcik7XG4gICAgICBsaW5lVmlldy5ndXR0ZXIgPSBudWxsO1xuICAgIH1cbiAgICB2YXIgbWFya2VycyA9IGxpbmVWaWV3LmxpbmUuZ3V0dGVyTWFya2VycztcbiAgICBpZiAoY20ub3B0aW9ucy5saW5lTnVtYmVycyB8fCBtYXJrZXJzKSB7XG4gICAgICB2YXIgd3JhcCA9IGVuc3VyZUxpbmVXcmFwcGVkKGxpbmVWaWV3KTtcbiAgICAgIHZhciBndXR0ZXJXcmFwID0gbGluZVZpZXcuZ3V0dGVyID1cbiAgICAgICAgd3JhcC5pbnNlcnRCZWZvcmUoZWx0KFwiZGl2XCIsIG51bGwsIFwiQ29kZU1pcnJvci1ndXR0ZXItd3JhcHBlclwiLCBcInBvc2l0aW9uOiBhYnNvbHV0ZTsgbGVmdDogXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKGNtLm9wdGlvbnMuZml4ZWRHdXR0ZXIgPyBkaW1zLmZpeGVkUG9zIDogLWRpbXMuZ3V0dGVyVG90YWxXaWR0aCkgKyBcInB4XCIpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICBsaW5lVmlldy50ZXh0KTtcbiAgICAgIGlmIChjbS5vcHRpb25zLmxpbmVOdW1iZXJzICYmICghbWFya2VycyB8fCAhbWFya2Vyc1tcIkNvZGVNaXJyb3ItbGluZW51bWJlcnNcIl0pKVxuICAgICAgICBsaW5lVmlldy5saW5lTnVtYmVyID0gZ3V0dGVyV3JhcC5hcHBlbmRDaGlsZChcbiAgICAgICAgICBlbHQoXCJkaXZcIiwgbGluZU51bWJlckZvcihjbS5vcHRpb25zLCBsaW5lTiksXG4gICAgICAgICAgICAgIFwiQ29kZU1pcnJvci1saW5lbnVtYmVyIENvZGVNaXJyb3ItZ3V0dGVyLWVsdFwiLFxuICAgICAgICAgICAgICBcImxlZnQ6IFwiICsgZGltcy5ndXR0ZXJMZWZ0W1wiQ29kZU1pcnJvci1saW5lbnVtYmVyc1wiXSArIFwicHg7IHdpZHRoOiBcIlxuICAgICAgICAgICAgICArIGNtLmRpc3BsYXkubGluZU51bUlubmVyV2lkdGggKyBcInB4XCIpKTtcbiAgICAgIGlmIChtYXJrZXJzKSBmb3IgKHZhciBrID0gMDsgayA8IGNtLm9wdGlvbnMuZ3V0dGVycy5sZW5ndGg7ICsraykge1xuICAgICAgICB2YXIgaWQgPSBjbS5vcHRpb25zLmd1dHRlcnNba10sIGZvdW5kID0gbWFya2Vycy5oYXNPd25Qcm9wZXJ0eShpZCkgJiYgbWFya2Vyc1tpZF07XG4gICAgICAgIGlmIChmb3VuZClcbiAgICAgICAgICBndXR0ZXJXcmFwLmFwcGVuZENoaWxkKGVsdChcImRpdlwiLCBbZm91bmRdLCBcIkNvZGVNaXJyb3ItZ3V0dGVyLWVsdFwiLCBcImxlZnQ6IFwiICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkaW1zLmd1dHRlckxlZnRbaWRdICsgXCJweDsgd2lkdGg6IFwiICsgZGltcy5ndXR0ZXJXaWR0aFtpZF0gKyBcInB4XCIpKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiB1cGRhdGVMaW5lV2lkZ2V0cyhsaW5lVmlldywgZGltcykge1xuICAgIGlmIChsaW5lVmlldy5hbGlnbmFibGUpIGxpbmVWaWV3LmFsaWduYWJsZSA9IG51bGw7XG4gICAgZm9yICh2YXIgbm9kZSA9IGxpbmVWaWV3Lm5vZGUuZmlyc3RDaGlsZCwgbmV4dDsgbm9kZTsgbm9kZSA9IG5leHQpIHtcbiAgICAgIHZhciBuZXh0ID0gbm9kZS5uZXh0U2libGluZztcbiAgICAgIGlmIChub2RlLmNsYXNzTmFtZSA9PSBcIkNvZGVNaXJyb3ItbGluZXdpZGdldFwiKVxuICAgICAgICBsaW5lVmlldy5ub2RlLnJlbW92ZUNoaWxkKG5vZGUpO1xuICAgIH1cbiAgICBpbnNlcnRMaW5lV2lkZ2V0cyhsaW5lVmlldywgZGltcyk7XG4gIH1cblxuICAvLyBCdWlsZCBhIGxpbmUncyBET00gcmVwcmVzZW50YXRpb24gZnJvbSBzY3JhdGNoXG4gIGZ1bmN0aW9uIGJ1aWxkTGluZUVsZW1lbnQoY20sIGxpbmVWaWV3LCBsaW5lTiwgZGltcykge1xuICAgIHZhciBidWlsdCA9IGdldExpbmVDb250ZW50KGNtLCBsaW5lVmlldyk7XG4gICAgbGluZVZpZXcudGV4dCA9IGxpbmVWaWV3Lm5vZGUgPSBidWlsdC5wcmU7XG4gICAgaWYgKGJ1aWx0LmJnQ2xhc3MpIGxpbmVWaWV3LmJnQ2xhc3MgPSBidWlsdC5iZ0NsYXNzO1xuICAgIGlmIChidWlsdC50ZXh0Q2xhc3MpIGxpbmVWaWV3LnRleHRDbGFzcyA9IGJ1aWx0LnRleHRDbGFzcztcblxuICAgIHVwZGF0ZUxpbmVDbGFzc2VzKGxpbmVWaWV3KTtcbiAgICB1cGRhdGVMaW5lR3V0dGVyKGNtLCBsaW5lVmlldywgbGluZU4sIGRpbXMpO1xuICAgIGluc2VydExpbmVXaWRnZXRzKGxpbmVWaWV3LCBkaW1zKTtcbiAgICByZXR1cm4gbGluZVZpZXcubm9kZTtcbiAgfVxuXG4gIC8vIEEgbGluZVZpZXcgbWF5IGNvbnRhaW4gbXVsdGlwbGUgbG9naWNhbCBsaW5lcyAod2hlbiBtZXJnZWQgYnlcbiAgLy8gY29sbGFwc2VkIHNwYW5zKS4gVGhlIHdpZGdldHMgZm9yIGFsbCBvZiB0aGVtIG5lZWQgdG8gYmUgZHJhd24uXG4gIGZ1bmN0aW9uIGluc2VydExpbmVXaWRnZXRzKGxpbmVWaWV3LCBkaW1zKSB7XG4gICAgaW5zZXJ0TGluZVdpZGdldHNGb3IobGluZVZpZXcubGluZSwgbGluZVZpZXcsIGRpbXMsIHRydWUpO1xuICAgIGlmIChsaW5lVmlldy5yZXN0KSBmb3IgKHZhciBpID0gMDsgaSA8IGxpbmVWaWV3LnJlc3QubGVuZ3RoOyBpKyspXG4gICAgICBpbnNlcnRMaW5lV2lkZ2V0c0ZvcihsaW5lVmlldy5yZXN0W2ldLCBsaW5lVmlldywgZGltcywgZmFsc2UpO1xuICB9XG5cbiAgZnVuY3Rpb24gaW5zZXJ0TGluZVdpZGdldHNGb3IobGluZSwgbGluZVZpZXcsIGRpbXMsIGFsbG93QWJvdmUpIHtcbiAgICBpZiAoIWxpbmUud2lkZ2V0cykgcmV0dXJuO1xuICAgIHZhciB3cmFwID0gZW5zdXJlTGluZVdyYXBwZWQobGluZVZpZXcpO1xuICAgIGZvciAodmFyIGkgPSAwLCB3cyA9IGxpbmUud2lkZ2V0czsgaSA8IHdzLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YXIgd2lkZ2V0ID0gd3NbaV0sIG5vZGUgPSBlbHQoXCJkaXZcIiwgW3dpZGdldC5ub2RlXSwgXCJDb2RlTWlycm9yLWxpbmV3aWRnZXRcIik7XG4gICAgICBpZiAoIXdpZGdldC5oYW5kbGVNb3VzZUV2ZW50cykgbm9kZS5pZ25vcmVFdmVudHMgPSB0cnVlO1xuICAgICAgcG9zaXRpb25MaW5lV2lkZ2V0KHdpZGdldCwgbm9kZSwgbGluZVZpZXcsIGRpbXMpO1xuICAgICAgaWYgKGFsbG93QWJvdmUgJiYgd2lkZ2V0LmFib3ZlKVxuICAgICAgICB3cmFwLmluc2VydEJlZm9yZShub2RlLCBsaW5lVmlldy5ndXR0ZXIgfHwgbGluZVZpZXcudGV4dCk7XG4gICAgICBlbHNlXG4gICAgICAgIHdyYXAuYXBwZW5kQ2hpbGQobm9kZSk7XG4gICAgICBzaWduYWxMYXRlcih3aWRnZXQsIFwicmVkcmF3XCIpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHBvc2l0aW9uTGluZVdpZGdldCh3aWRnZXQsIG5vZGUsIGxpbmVWaWV3LCBkaW1zKSB7XG4gICAgaWYgKHdpZGdldC5ub0hTY3JvbGwpIHtcbiAgICAgIChsaW5lVmlldy5hbGlnbmFibGUgfHwgKGxpbmVWaWV3LmFsaWduYWJsZSA9IFtdKSkucHVzaChub2RlKTtcbiAgICAgIHZhciB3aWR0aCA9IGRpbXMud3JhcHBlcldpZHRoO1xuICAgICAgbm9kZS5zdHlsZS5sZWZ0ID0gZGltcy5maXhlZFBvcyArIFwicHhcIjtcbiAgICAgIGlmICghd2lkZ2V0LmNvdmVyR3V0dGVyKSB7XG4gICAgICAgIHdpZHRoIC09IGRpbXMuZ3V0dGVyVG90YWxXaWR0aDtcbiAgICAgICAgbm9kZS5zdHlsZS5wYWRkaW5nTGVmdCA9IGRpbXMuZ3V0dGVyVG90YWxXaWR0aCArIFwicHhcIjtcbiAgICAgIH1cbiAgICAgIG5vZGUuc3R5bGUud2lkdGggPSB3aWR0aCArIFwicHhcIjtcbiAgICB9XG4gICAgaWYgKHdpZGdldC5jb3Zlckd1dHRlcikge1xuICAgICAgbm9kZS5zdHlsZS56SW5kZXggPSA1O1xuICAgICAgbm9kZS5zdHlsZS5wb3NpdGlvbiA9IFwicmVsYXRpdmVcIjtcbiAgICAgIGlmICghd2lkZ2V0Lm5vSFNjcm9sbCkgbm9kZS5zdHlsZS5tYXJnaW5MZWZ0ID0gLWRpbXMuZ3V0dGVyVG90YWxXaWR0aCArIFwicHhcIjtcbiAgICB9XG4gIH1cblxuICAvLyBQT1NJVElPTiBPQkpFQ1RcblxuICAvLyBBIFBvcyBpbnN0YW5jZSByZXByZXNlbnRzIGEgcG9zaXRpb24gd2l0aGluIHRoZSB0ZXh0LlxuICB2YXIgUG9zID0gQ29kZU1pcnJvci5Qb3MgPSBmdW5jdGlvbihsaW5lLCBjaCkge1xuICAgIGlmICghKHRoaXMgaW5zdGFuY2VvZiBQb3MpKSByZXR1cm4gbmV3IFBvcyhsaW5lLCBjaCk7XG4gICAgdGhpcy5saW5lID0gbGluZTsgdGhpcy5jaCA9IGNoO1xuICB9O1xuXG4gIC8vIENvbXBhcmUgdHdvIHBvc2l0aW9ucywgcmV0dXJuIDAgaWYgdGhleSBhcmUgdGhlIHNhbWUsIGEgbmVnYXRpdmVcbiAgLy8gbnVtYmVyIHdoZW4gYSBpcyBsZXNzLCBhbmQgYSBwb3NpdGl2ZSBudW1iZXIgb3RoZXJ3aXNlLlxuICB2YXIgY21wID0gQ29kZU1pcnJvci5jbXBQb3MgPSBmdW5jdGlvbihhLCBiKSB7IHJldHVybiBhLmxpbmUgLSBiLmxpbmUgfHwgYS5jaCAtIGIuY2g7IH07XG5cbiAgZnVuY3Rpb24gY29weVBvcyh4KSB7cmV0dXJuIFBvcyh4LmxpbmUsIHguY2gpO31cbiAgZnVuY3Rpb24gbWF4UG9zKGEsIGIpIHsgcmV0dXJuIGNtcChhLCBiKSA8IDAgPyBiIDogYTsgfVxuICBmdW5jdGlvbiBtaW5Qb3MoYSwgYikgeyByZXR1cm4gY21wKGEsIGIpIDwgMCA/IGEgOiBiOyB9XG5cbiAgLy8gU0VMRUNUSU9OIC8gQ1VSU09SXG5cbiAgLy8gU2VsZWN0aW9uIG9iamVjdHMgYXJlIGltbXV0YWJsZS4gQSBuZXcgb25lIGlzIGNyZWF0ZWQgZXZlcnkgdGltZVxuICAvLyB0aGUgc2VsZWN0aW9uIGNoYW5nZXMuIEEgc2VsZWN0aW9uIGlzIG9uZSBvciBtb3JlIG5vbi1vdmVybGFwcGluZ1xuICAvLyAoYW5kIG5vbi10b3VjaGluZykgcmFuZ2VzLCBzb3J0ZWQsIGFuZCBhbiBpbnRlZ2VyIHRoYXQgaW5kaWNhdGVzXG4gIC8vIHdoaWNoIG9uZSBpcyB0aGUgcHJpbWFyeSBzZWxlY3Rpb24gKHRoZSBvbmUgdGhhdCdzIHNjcm9sbGVkIGludG9cbiAgLy8gdmlldywgdGhhdCBnZXRDdXJzb3IgcmV0dXJucywgZXRjKS5cbiAgZnVuY3Rpb24gU2VsZWN0aW9uKHJhbmdlcywgcHJpbUluZGV4KSB7XG4gICAgdGhpcy5yYW5nZXMgPSByYW5nZXM7XG4gICAgdGhpcy5wcmltSW5kZXggPSBwcmltSW5kZXg7XG4gIH1cblxuICBTZWxlY3Rpb24ucHJvdG90eXBlID0ge1xuICAgIHByaW1hcnk6IGZ1bmN0aW9uKCkgeyByZXR1cm4gdGhpcy5yYW5nZXNbdGhpcy5wcmltSW5kZXhdOyB9LFxuICAgIGVxdWFsczogZnVuY3Rpb24ob3RoZXIpIHtcbiAgICAgIGlmIChvdGhlciA9PSB0aGlzKSByZXR1cm4gdHJ1ZTtcbiAgICAgIGlmIChvdGhlci5wcmltSW5kZXggIT0gdGhpcy5wcmltSW5kZXggfHwgb3RoZXIucmFuZ2VzLmxlbmd0aCAhPSB0aGlzLnJhbmdlcy5sZW5ndGgpIHJldHVybiBmYWxzZTtcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdGhpcy5yYW5nZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgdmFyIGhlcmUgPSB0aGlzLnJhbmdlc1tpXSwgdGhlcmUgPSBvdGhlci5yYW5nZXNbaV07XG4gICAgICAgIGlmIChjbXAoaGVyZS5hbmNob3IsIHRoZXJlLmFuY2hvcikgIT0gMCB8fCBjbXAoaGVyZS5oZWFkLCB0aGVyZS5oZWFkKSAhPSAwKSByZXR1cm4gZmFsc2U7XG4gICAgICB9XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuICAgIGRlZXBDb3B5OiBmdW5jdGlvbigpIHtcbiAgICAgIGZvciAodmFyIG91dCA9IFtdLCBpID0gMDsgaSA8IHRoaXMucmFuZ2VzLmxlbmd0aDsgaSsrKVxuICAgICAgICBvdXRbaV0gPSBuZXcgUmFuZ2UoY29weVBvcyh0aGlzLnJhbmdlc1tpXS5hbmNob3IpLCBjb3B5UG9zKHRoaXMucmFuZ2VzW2ldLmhlYWQpKTtcbiAgICAgIHJldHVybiBuZXcgU2VsZWN0aW9uKG91dCwgdGhpcy5wcmltSW5kZXgpO1xuICAgIH0sXG4gICAgc29tZXRoaW5nU2VsZWN0ZWQ6IGZ1bmN0aW9uKCkge1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLnJhbmdlcy5sZW5ndGg7IGkrKylcbiAgICAgICAgaWYgKCF0aGlzLnJhbmdlc1tpXS5lbXB0eSgpKSByZXR1cm4gdHJ1ZTtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9LFxuICAgIGNvbnRhaW5zOiBmdW5jdGlvbihwb3MsIGVuZCkge1xuICAgICAgaWYgKCFlbmQpIGVuZCA9IHBvcztcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdGhpcy5yYW5nZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgdmFyIHJhbmdlID0gdGhpcy5yYW5nZXNbaV07XG4gICAgICAgIGlmIChjbXAoZW5kLCByYW5nZS5mcm9tKCkpID49IDAgJiYgY21wKHBvcywgcmFuZ2UudG8oKSkgPD0gMClcbiAgICAgICAgICByZXR1cm4gaTtcbiAgICAgIH1cbiAgICAgIHJldHVybiAtMTtcbiAgICB9XG4gIH07XG5cbiAgZnVuY3Rpb24gUmFuZ2UoYW5jaG9yLCBoZWFkKSB7XG4gICAgdGhpcy5hbmNob3IgPSBhbmNob3I7IHRoaXMuaGVhZCA9IGhlYWQ7XG4gIH1cblxuICBSYW5nZS5wcm90b3R5cGUgPSB7XG4gICAgZnJvbTogZnVuY3Rpb24oKSB7IHJldHVybiBtaW5Qb3ModGhpcy5hbmNob3IsIHRoaXMuaGVhZCk7IH0sXG4gICAgdG86IGZ1bmN0aW9uKCkgeyByZXR1cm4gbWF4UG9zKHRoaXMuYW5jaG9yLCB0aGlzLmhlYWQpOyB9LFxuICAgIGVtcHR5OiBmdW5jdGlvbigpIHtcbiAgICAgIHJldHVybiB0aGlzLmhlYWQubGluZSA9PSB0aGlzLmFuY2hvci5saW5lICYmIHRoaXMuaGVhZC5jaCA9PSB0aGlzLmFuY2hvci5jaDtcbiAgICB9XG4gIH07XG5cbiAgLy8gVGFrZSBhbiB1bnNvcnRlZCwgcG90ZW50aWFsbHkgb3ZlcmxhcHBpbmcgc2V0IG9mIHJhbmdlcywgYW5kXG4gIC8vIGJ1aWxkIGEgc2VsZWN0aW9uIG91dCBvZiBpdC4gJ0NvbnN1bWVzJyByYW5nZXMgYXJyYXkgKG1vZGlmeWluZ1xuICAvLyBpdCkuXG4gIGZ1bmN0aW9uIG5vcm1hbGl6ZVNlbGVjdGlvbihyYW5nZXMsIHByaW1JbmRleCkge1xuICAgIHZhciBwcmltID0gcmFuZ2VzW3ByaW1JbmRleF07XG4gICAgcmFuZ2VzLnNvcnQoZnVuY3Rpb24oYSwgYikgeyByZXR1cm4gY21wKGEuZnJvbSgpLCBiLmZyb20oKSk7IH0pO1xuICAgIHByaW1JbmRleCA9IGluZGV4T2YocmFuZ2VzLCBwcmltKTtcbiAgICBmb3IgKHZhciBpID0gMTsgaSA8IHJhbmdlcy5sZW5ndGg7IGkrKykge1xuICAgICAgdmFyIGN1ciA9IHJhbmdlc1tpXSwgcHJldiA9IHJhbmdlc1tpIC0gMV07XG4gICAgICBpZiAoY21wKHByZXYudG8oKSwgY3VyLmZyb20oKSkgPj0gMCkge1xuICAgICAgICB2YXIgZnJvbSA9IG1pblBvcyhwcmV2LmZyb20oKSwgY3VyLmZyb20oKSksIHRvID0gbWF4UG9zKHByZXYudG8oKSwgY3VyLnRvKCkpO1xuICAgICAgICB2YXIgaW52ID0gcHJldi5lbXB0eSgpID8gY3VyLmZyb20oKSA9PSBjdXIuaGVhZCA6IHByZXYuZnJvbSgpID09IHByZXYuaGVhZDtcbiAgICAgICAgaWYgKGkgPD0gcHJpbUluZGV4KSAtLXByaW1JbmRleDtcbiAgICAgICAgcmFuZ2VzLnNwbGljZSgtLWksIDIsIG5ldyBSYW5nZShpbnYgPyB0byA6IGZyb20sIGludiA/IGZyb20gOiB0bykpO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gbmV3IFNlbGVjdGlvbihyYW5nZXMsIHByaW1JbmRleCk7XG4gIH1cblxuICBmdW5jdGlvbiBzaW1wbGVTZWxlY3Rpb24oYW5jaG9yLCBoZWFkKSB7XG4gICAgcmV0dXJuIG5ldyBTZWxlY3Rpb24oW25ldyBSYW5nZShhbmNob3IsIGhlYWQgfHwgYW5jaG9yKV0sIDApO1xuICB9XG5cbiAgLy8gTW9zdCBvZiB0aGUgZXh0ZXJuYWwgQVBJIGNsaXBzIGdpdmVuIHBvc2l0aW9ucyB0byBtYWtlIHN1cmUgdGhleVxuICAvLyBhY3R1YWxseSBleGlzdCB3aXRoaW4gdGhlIGRvY3VtZW50LlxuICBmdW5jdGlvbiBjbGlwTGluZShkb2MsIG4pIHtyZXR1cm4gTWF0aC5tYXgoZG9jLmZpcnN0LCBNYXRoLm1pbihuLCBkb2MuZmlyc3QgKyBkb2Muc2l6ZSAtIDEpKTt9XG4gIGZ1bmN0aW9uIGNsaXBQb3MoZG9jLCBwb3MpIHtcbiAgICBpZiAocG9zLmxpbmUgPCBkb2MuZmlyc3QpIHJldHVybiBQb3MoZG9jLmZpcnN0LCAwKTtcbiAgICB2YXIgbGFzdCA9IGRvYy5maXJzdCArIGRvYy5zaXplIC0gMTtcbiAgICBpZiAocG9zLmxpbmUgPiBsYXN0KSByZXR1cm4gUG9zKGxhc3QsIGdldExpbmUoZG9jLCBsYXN0KS50ZXh0Lmxlbmd0aCk7XG4gICAgcmV0dXJuIGNsaXBUb0xlbihwb3MsIGdldExpbmUoZG9jLCBwb3MubGluZSkudGV4dC5sZW5ndGgpO1xuICB9XG4gIGZ1bmN0aW9uIGNsaXBUb0xlbihwb3MsIGxpbmVsZW4pIHtcbiAgICB2YXIgY2ggPSBwb3MuY2g7XG4gICAgaWYgKGNoID09IG51bGwgfHwgY2ggPiBsaW5lbGVuKSByZXR1cm4gUG9zKHBvcy5saW5lLCBsaW5lbGVuKTtcbiAgICBlbHNlIGlmIChjaCA8IDApIHJldHVybiBQb3MocG9zLmxpbmUsIDApO1xuICAgIGVsc2UgcmV0dXJuIHBvcztcbiAgfVxuICBmdW5jdGlvbiBpc0xpbmUoZG9jLCBsKSB7cmV0dXJuIGwgPj0gZG9jLmZpcnN0ICYmIGwgPCBkb2MuZmlyc3QgKyBkb2Muc2l6ZTt9XG4gIGZ1bmN0aW9uIGNsaXBQb3NBcnJheShkb2MsIGFycmF5KSB7XG4gICAgZm9yICh2YXIgb3V0ID0gW10sIGkgPSAwOyBpIDwgYXJyYXkubGVuZ3RoOyBpKyspIG91dFtpXSA9IGNsaXBQb3MoZG9jLCBhcnJheVtpXSk7XG4gICAgcmV0dXJuIG91dDtcbiAgfVxuXG4gIC8vIFNFTEVDVElPTiBVUERBVEVTXG5cbiAgLy8gVGhlICdzY3JvbGwnIHBhcmFtZXRlciBnaXZlbiB0byBtYW55IG9mIHRoZXNlIGluZGljYXRlZCB3aGV0aGVyXG4gIC8vIHRoZSBuZXcgY3Vyc29yIHBvc2l0aW9uIHNob3VsZCBiZSBzY3JvbGxlZCBpbnRvIHZpZXcgYWZ0ZXJcbiAgLy8gbW9kaWZ5aW5nIHRoZSBzZWxlY3Rpb24uXG5cbiAgLy8gSWYgc2hpZnQgaXMgaGVsZCBvciB0aGUgZXh0ZW5kIGZsYWcgaXMgc2V0LCBleHRlbmRzIGEgcmFuZ2UgdG9cbiAgLy8gaW5jbHVkZSBhIGdpdmVuIHBvc2l0aW9uIChhbmQgb3B0aW9uYWxseSBhIHNlY29uZCBwb3NpdGlvbikuXG4gIC8vIE90aGVyd2lzZSwgc2ltcGx5IHJldHVybnMgdGhlIHJhbmdlIGJldHdlZW4gdGhlIGdpdmVuIHBvc2l0aW9ucy5cbiAgLy8gVXNlZCBmb3IgY3Vyc29yIG1vdGlvbiBhbmQgc3VjaC5cbiAgZnVuY3Rpb24gZXh0ZW5kUmFuZ2UoZG9jLCByYW5nZSwgaGVhZCwgb3RoZXIpIHtcbiAgICBpZiAoZG9jLmNtICYmIGRvYy5jbS5kaXNwbGF5LnNoaWZ0IHx8IGRvYy5leHRlbmQpIHtcbiAgICAgIHZhciBhbmNob3IgPSByYW5nZS5hbmNob3I7XG4gICAgICBpZiAob3RoZXIpIHtcbiAgICAgICAgdmFyIHBvc0JlZm9yZSA9IGNtcChoZWFkLCBhbmNob3IpIDwgMDtcbiAgICAgICAgaWYgKHBvc0JlZm9yZSAhPSAoY21wKG90aGVyLCBhbmNob3IpIDwgMCkpIHtcbiAgICAgICAgICBhbmNob3IgPSBoZWFkO1xuICAgICAgICAgIGhlYWQgPSBvdGhlcjtcbiAgICAgICAgfSBlbHNlIGlmIChwb3NCZWZvcmUgIT0gKGNtcChoZWFkLCBvdGhlcikgPCAwKSkge1xuICAgICAgICAgIGhlYWQgPSBvdGhlcjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIG5ldyBSYW5nZShhbmNob3IsIGhlYWQpO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gbmV3IFJhbmdlKG90aGVyIHx8IGhlYWQsIGhlYWQpO1xuICAgIH1cbiAgfVxuXG4gIC8vIEV4dGVuZCB0aGUgcHJpbWFyeSBzZWxlY3Rpb24gcmFuZ2UsIGRpc2NhcmQgdGhlIHJlc3QuXG4gIGZ1bmN0aW9uIGV4dGVuZFNlbGVjdGlvbihkb2MsIGhlYWQsIG90aGVyLCBvcHRpb25zKSB7XG4gICAgc2V0U2VsZWN0aW9uKGRvYywgbmV3IFNlbGVjdGlvbihbZXh0ZW5kUmFuZ2UoZG9jLCBkb2Muc2VsLnByaW1hcnkoKSwgaGVhZCwgb3RoZXIpXSwgMCksIG9wdGlvbnMpO1xuICB9XG5cbiAgLy8gRXh0ZW5kIGFsbCBzZWxlY3Rpb25zIChwb3MgaXMgYW4gYXJyYXkgb2Ygc2VsZWN0aW9ucyB3aXRoIGxlbmd0aFxuICAvLyBlcXVhbCB0aGUgbnVtYmVyIG9mIHNlbGVjdGlvbnMpXG4gIGZ1bmN0aW9uIGV4dGVuZFNlbGVjdGlvbnMoZG9jLCBoZWFkcywgb3B0aW9ucykge1xuICAgIGZvciAodmFyIG91dCA9IFtdLCBpID0gMDsgaSA8IGRvYy5zZWwucmFuZ2VzLmxlbmd0aDsgaSsrKVxuICAgICAgb3V0W2ldID0gZXh0ZW5kUmFuZ2UoZG9jLCBkb2Muc2VsLnJhbmdlc1tpXSwgaGVhZHNbaV0sIG51bGwpO1xuICAgIHZhciBuZXdTZWwgPSBub3JtYWxpemVTZWxlY3Rpb24ob3V0LCBkb2Muc2VsLnByaW1JbmRleCk7XG4gICAgc2V0U2VsZWN0aW9uKGRvYywgbmV3U2VsLCBvcHRpb25zKTtcbiAgfVxuXG4gIC8vIFVwZGF0ZXMgYSBzaW5nbGUgcmFuZ2UgaW4gdGhlIHNlbGVjdGlvbi5cbiAgZnVuY3Rpb24gcmVwbGFjZU9uZVNlbGVjdGlvbihkb2MsIGksIHJhbmdlLCBvcHRpb25zKSB7XG4gICAgdmFyIHJhbmdlcyA9IGRvYy5zZWwucmFuZ2VzLnNsaWNlKDApO1xuICAgIHJhbmdlc1tpXSA9IHJhbmdlO1xuICAgIHNldFNlbGVjdGlvbihkb2MsIG5vcm1hbGl6ZVNlbGVjdGlvbihyYW5nZXMsIGRvYy5zZWwucHJpbUluZGV4KSwgb3B0aW9ucyk7XG4gIH1cblxuICAvLyBSZXNldCB0aGUgc2VsZWN0aW9uIHRvIGEgc2luZ2xlIHJhbmdlLlxuICBmdW5jdGlvbiBzZXRTaW1wbGVTZWxlY3Rpb24oZG9jLCBhbmNob3IsIGhlYWQsIG9wdGlvbnMpIHtcbiAgICBzZXRTZWxlY3Rpb24oZG9jLCBzaW1wbGVTZWxlY3Rpb24oYW5jaG9yLCBoZWFkKSwgb3B0aW9ucyk7XG4gIH1cblxuICAvLyBHaXZlIGJlZm9yZVNlbGVjdGlvbkNoYW5nZSBoYW5kbGVycyBhIGNoYW5nZSB0byBpbmZsdWVuY2UgYVxuICAvLyBzZWxlY3Rpb24gdXBkYXRlLlxuICBmdW5jdGlvbiBmaWx0ZXJTZWxlY3Rpb25DaGFuZ2UoZG9jLCBzZWwpIHtcbiAgICB2YXIgb2JqID0ge1xuICAgICAgcmFuZ2VzOiBzZWwucmFuZ2VzLFxuICAgICAgdXBkYXRlOiBmdW5jdGlvbihyYW5nZXMpIHtcbiAgICAgICAgdGhpcy5yYW5nZXMgPSBbXTtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCByYW5nZXMubGVuZ3RoOyBpKyspXG4gICAgICAgICAgdGhpcy5yYW5nZXNbaV0gPSBuZXcgUmFuZ2UoY2xpcFBvcyhkb2MsIHJhbmdlc1tpXS5hbmNob3IpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsaXBQb3MoZG9jLCByYW5nZXNbaV0uaGVhZCkpO1xuICAgICAgfVxuICAgIH07XG4gICAgc2lnbmFsKGRvYywgXCJiZWZvcmVTZWxlY3Rpb25DaGFuZ2VcIiwgZG9jLCBvYmopO1xuICAgIGlmIChkb2MuY20pIHNpZ25hbChkb2MuY20sIFwiYmVmb3JlU2VsZWN0aW9uQ2hhbmdlXCIsIGRvYy5jbSwgb2JqKTtcbiAgICBpZiAob2JqLnJhbmdlcyAhPSBzZWwucmFuZ2VzKSByZXR1cm4gbm9ybWFsaXplU2VsZWN0aW9uKG9iai5yYW5nZXMsIG9iai5yYW5nZXMubGVuZ3RoIC0gMSk7XG4gICAgZWxzZSByZXR1cm4gc2VsO1xuICB9XG5cbiAgZnVuY3Rpb24gc2V0U2VsZWN0aW9uUmVwbGFjZUhpc3RvcnkoZG9jLCBzZWwsIG9wdGlvbnMpIHtcbiAgICB2YXIgZG9uZSA9IGRvYy5oaXN0b3J5LmRvbmUsIGxhc3QgPSBsc3QoZG9uZSk7XG4gICAgaWYgKGxhc3QgJiYgbGFzdC5yYW5nZXMpIHtcbiAgICAgIGRvbmVbZG9uZS5sZW5ndGggLSAxXSA9IHNlbDtcbiAgICAgIHNldFNlbGVjdGlvbk5vVW5kbyhkb2MsIHNlbCwgb3B0aW9ucyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHNldFNlbGVjdGlvbihkb2MsIHNlbCwgb3B0aW9ucyk7XG4gICAgfVxuICB9XG5cbiAgLy8gU2V0IGEgbmV3IHNlbGVjdGlvbi5cbiAgZnVuY3Rpb24gc2V0U2VsZWN0aW9uKGRvYywgc2VsLCBvcHRpb25zKSB7XG4gICAgc2V0U2VsZWN0aW9uTm9VbmRvKGRvYywgc2VsLCBvcHRpb25zKTtcbiAgICBhZGRTZWxlY3Rpb25Ub0hpc3RvcnkoZG9jLCBkb2Muc2VsLCBkb2MuY20gPyBkb2MuY20uY3VyT3AuaWQgOiBOYU4sIG9wdGlvbnMpO1xuICB9XG5cbiAgZnVuY3Rpb24gc2V0U2VsZWN0aW9uTm9VbmRvKGRvYywgc2VsLCBvcHRpb25zKSB7XG4gICAgaWYgKGhhc0hhbmRsZXIoZG9jLCBcImJlZm9yZVNlbGVjdGlvbkNoYW5nZVwiKSB8fCBkb2MuY20gJiYgaGFzSGFuZGxlcihkb2MuY20sIFwiYmVmb3JlU2VsZWN0aW9uQ2hhbmdlXCIpKVxuICAgICAgc2VsID0gZmlsdGVyU2VsZWN0aW9uQ2hhbmdlKGRvYywgc2VsKTtcblxuICAgIHZhciBiaWFzID0gb3B0aW9ucyAmJiBvcHRpb25zLmJpYXMgfHxcbiAgICAgIChjbXAoc2VsLnByaW1hcnkoKS5oZWFkLCBkb2Muc2VsLnByaW1hcnkoKS5oZWFkKSA8IDAgPyAtMSA6IDEpO1xuICAgIHNldFNlbGVjdGlvbklubmVyKGRvYywgc2tpcEF0b21pY0luU2VsZWN0aW9uKGRvYywgc2VsLCBiaWFzLCB0cnVlKSk7XG5cbiAgICBpZiAoIShvcHRpb25zICYmIG9wdGlvbnMuc2Nyb2xsID09PSBmYWxzZSkgJiYgZG9jLmNtKVxuICAgICAgZW5zdXJlQ3Vyc29yVmlzaWJsZShkb2MuY20pO1xuICB9XG5cbiAgZnVuY3Rpb24gc2V0U2VsZWN0aW9uSW5uZXIoZG9jLCBzZWwpIHtcbiAgICBpZiAoc2VsLmVxdWFscyhkb2Muc2VsKSkgcmV0dXJuO1xuXG4gICAgZG9jLnNlbCA9IHNlbDtcblxuICAgIGlmIChkb2MuY20pIHtcbiAgICAgIGRvYy5jbS5jdXJPcC51cGRhdGVJbnB1dCA9IGRvYy5jbS5jdXJPcC5zZWxlY3Rpb25DaGFuZ2VkID0gdHJ1ZTtcbiAgICAgIHNpZ25hbEN1cnNvckFjdGl2aXR5KGRvYy5jbSk7XG4gICAgfVxuICAgIHNpZ25hbExhdGVyKGRvYywgXCJjdXJzb3JBY3Rpdml0eVwiLCBkb2MpO1xuICB9XG5cbiAgLy8gVmVyaWZ5IHRoYXQgdGhlIHNlbGVjdGlvbiBkb2VzIG5vdCBwYXJ0aWFsbHkgc2VsZWN0IGFueSBhdG9taWNcbiAgLy8gbWFya2VkIHJhbmdlcy5cbiAgZnVuY3Rpb24gcmVDaGVja1NlbGVjdGlvbihkb2MpIHtcbiAgICBzZXRTZWxlY3Rpb25Jbm5lcihkb2MsIHNraXBBdG9taWNJblNlbGVjdGlvbihkb2MsIGRvYy5zZWwsIG51bGwsIGZhbHNlKSwgc2VsX2RvbnRTY3JvbGwpO1xuICB9XG5cbiAgLy8gUmV0dXJuIGEgc2VsZWN0aW9uIHRoYXQgZG9lcyBub3QgcGFydGlhbGx5IHNlbGVjdCBhbnkgYXRvbWljXG4gIC8vIHJhbmdlcy5cbiAgZnVuY3Rpb24gc2tpcEF0b21pY0luU2VsZWN0aW9uKGRvYywgc2VsLCBiaWFzLCBtYXlDbGVhcikge1xuICAgIHZhciBvdXQ7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBzZWwucmFuZ2VzLmxlbmd0aDsgaSsrKSB7XG4gICAgICB2YXIgcmFuZ2UgPSBzZWwucmFuZ2VzW2ldO1xuICAgICAgdmFyIG5ld0FuY2hvciA9IHNraXBBdG9taWMoZG9jLCByYW5nZS5hbmNob3IsIGJpYXMsIG1heUNsZWFyKTtcbiAgICAgIHZhciBuZXdIZWFkID0gc2tpcEF0b21pYyhkb2MsIHJhbmdlLmhlYWQsIGJpYXMsIG1heUNsZWFyKTtcbiAgICAgIGlmIChvdXQgfHwgbmV3QW5jaG9yICE9IHJhbmdlLmFuY2hvciB8fCBuZXdIZWFkICE9IHJhbmdlLmhlYWQpIHtcbiAgICAgICAgaWYgKCFvdXQpIG91dCA9IHNlbC5yYW5nZXMuc2xpY2UoMCwgaSk7XG4gICAgICAgIG91dFtpXSA9IG5ldyBSYW5nZShuZXdBbmNob3IsIG5ld0hlYWQpO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gb3V0ID8gbm9ybWFsaXplU2VsZWN0aW9uKG91dCwgc2VsLnByaW1JbmRleCkgOiBzZWw7XG4gIH1cblxuICAvLyBFbnN1cmUgYSBnaXZlbiBwb3NpdGlvbiBpcyBub3QgaW5zaWRlIGFuIGF0b21pYyByYW5nZS5cbiAgZnVuY3Rpb24gc2tpcEF0b21pYyhkb2MsIHBvcywgYmlhcywgbWF5Q2xlYXIpIHtcbiAgICB2YXIgZmxpcHBlZCA9IGZhbHNlLCBjdXJQb3MgPSBwb3M7XG4gICAgdmFyIGRpciA9IGJpYXMgfHwgMTtcbiAgICBkb2MuY2FudEVkaXQgPSBmYWxzZTtcbiAgICBzZWFyY2g6IGZvciAoOzspIHtcbiAgICAgIHZhciBsaW5lID0gZ2V0TGluZShkb2MsIGN1clBvcy5saW5lKTtcbiAgICAgIGlmIChsaW5lLm1hcmtlZFNwYW5zKSB7XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGluZS5tYXJrZWRTcGFucy5sZW5ndGg7ICsraSkge1xuICAgICAgICAgIHZhciBzcCA9IGxpbmUubWFya2VkU3BhbnNbaV0sIG0gPSBzcC5tYXJrZXI7XG4gICAgICAgICAgaWYgKChzcC5mcm9tID09IG51bGwgfHwgKG0uaW5jbHVzaXZlTGVmdCA/IHNwLmZyb20gPD0gY3VyUG9zLmNoIDogc3AuZnJvbSA8IGN1clBvcy5jaCkpICYmXG4gICAgICAgICAgICAgIChzcC50byA9PSBudWxsIHx8IChtLmluY2x1c2l2ZVJpZ2h0ID8gc3AudG8gPj0gY3VyUG9zLmNoIDogc3AudG8gPiBjdXJQb3MuY2gpKSkge1xuICAgICAgICAgICAgaWYgKG1heUNsZWFyKSB7XG4gICAgICAgICAgICAgIHNpZ25hbChtLCBcImJlZm9yZUN1cnNvckVudGVyXCIpO1xuICAgICAgICAgICAgICBpZiAobS5leHBsaWNpdGx5Q2xlYXJlZCkge1xuICAgICAgICAgICAgICAgIGlmICghbGluZS5tYXJrZWRTcGFucykgYnJlYWs7XG4gICAgICAgICAgICAgICAgZWxzZSB7LS1pOyBjb250aW51ZTt9XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghbS5hdG9taWMpIGNvbnRpbnVlO1xuICAgICAgICAgICAgdmFyIG5ld1BvcyA9IG0uZmluZChkaXIgPCAwID8gLTEgOiAxKTtcbiAgICAgICAgICAgIGlmIChjbXAobmV3UG9zLCBjdXJQb3MpID09IDApIHtcbiAgICAgICAgICAgICAgbmV3UG9zLmNoICs9IGRpcjtcbiAgICAgICAgICAgICAgaWYgKG5ld1Bvcy5jaCA8IDApIHtcbiAgICAgICAgICAgICAgICBpZiAobmV3UG9zLmxpbmUgPiBkb2MuZmlyc3QpIG5ld1BvcyA9IGNsaXBQb3MoZG9jLCBQb3MobmV3UG9zLmxpbmUgLSAxKSk7XG4gICAgICAgICAgICAgICAgZWxzZSBuZXdQb3MgPSBudWxsO1xuICAgICAgICAgICAgICB9IGVsc2UgaWYgKG5ld1Bvcy5jaCA+IGxpbmUudGV4dC5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBpZiAobmV3UG9zLmxpbmUgPCBkb2MuZmlyc3QgKyBkb2Muc2l6ZSAtIDEpIG5ld1BvcyA9IFBvcyhuZXdQb3MubGluZSArIDEsIDApO1xuICAgICAgICAgICAgICAgIGVsc2UgbmV3UG9zID0gbnVsbDtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBpZiAoIW5ld1Bvcykge1xuICAgICAgICAgICAgICAgIGlmIChmbGlwcGVkKSB7XG4gICAgICAgICAgICAgICAgICAvLyBEcml2ZW4gaW4gYSBjb3JuZXIgLS0gbm8gdmFsaWQgY3Vyc29yIHBvc2l0aW9uIGZvdW5kIGF0IGFsbFxuICAgICAgICAgICAgICAgICAgLy8gLS0gdHJ5IGFnYWluICp3aXRoKiBjbGVhcmluZywgaWYgd2UgZGlkbid0IGFscmVhZHlcbiAgICAgICAgICAgICAgICAgIGlmICghbWF5Q2xlYXIpIHJldHVybiBza2lwQXRvbWljKGRvYywgcG9zLCBiaWFzLCB0cnVlKTtcbiAgICAgICAgICAgICAgICAgIC8vIE90aGVyd2lzZSwgdHVybiBvZmYgZWRpdGluZyB1bnRpbCBmdXJ0aGVyIG5vdGljZSwgYW5kIHJldHVybiB0aGUgc3RhcnQgb2YgdGhlIGRvY1xuICAgICAgICAgICAgICAgICAgZG9jLmNhbnRFZGl0ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBQb3MoZG9jLmZpcnN0LCAwKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZmxpcHBlZCA9IHRydWU7IG5ld1BvcyA9IHBvczsgZGlyID0gLWRpcjtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY3VyUG9zID0gbmV3UG9zO1xuICAgICAgICAgICAgY29udGludWUgc2VhcmNoO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIGN1clBvcztcbiAgICB9XG4gIH1cblxuICAvLyBTRUxFQ1RJT04gRFJBV0lOR1xuXG4gIC8vIFJlZHJhdyB0aGUgc2VsZWN0aW9uIGFuZC9vciBjdXJzb3JcbiAgZnVuY3Rpb24gZHJhd1NlbGVjdGlvbihjbSkge1xuICAgIHZhciBkaXNwbGF5ID0gY20uZGlzcGxheSwgZG9jID0gY20uZG9jLCByZXN1bHQgPSB7fTtcbiAgICB2YXIgY3VyRnJhZ21lbnQgPSByZXN1bHQuY3Vyc29ycyA9IGRvY3VtZW50LmNyZWF0ZURvY3VtZW50RnJhZ21lbnQoKTtcbiAgICB2YXIgc2VsRnJhZ21lbnQgPSByZXN1bHQuc2VsZWN0aW9uID0gZG9jdW1lbnQuY3JlYXRlRG9jdW1lbnRGcmFnbWVudCgpO1xuXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBkb2Muc2VsLnJhbmdlcy5sZW5ndGg7IGkrKykge1xuICAgICAgdmFyIHJhbmdlID0gZG9jLnNlbC5yYW5nZXNbaV07XG4gICAgICB2YXIgY29sbGFwc2VkID0gcmFuZ2UuZW1wdHkoKTtcbiAgICAgIGlmIChjb2xsYXBzZWQgfHwgY20ub3B0aW9ucy5zaG93Q3Vyc29yV2hlblNlbGVjdGluZylcbiAgICAgICAgZHJhd1NlbGVjdGlvbkN1cnNvcihjbSwgcmFuZ2UsIGN1ckZyYWdtZW50KTtcbiAgICAgIGlmICghY29sbGFwc2VkKVxuICAgICAgICBkcmF3U2VsZWN0aW9uUmFuZ2UoY20sIHJhbmdlLCBzZWxGcmFnbWVudCk7XG4gICAgfVxuXG4gICAgLy8gTW92ZSB0aGUgaGlkZGVuIHRleHRhcmVhIG5lYXIgdGhlIGN1cnNvciB0byBwcmV2ZW50IHNjcm9sbGluZyBhcnRpZmFjdHNcbiAgICBpZiAoY20ub3B0aW9ucy5tb3ZlSW5wdXRXaXRoQ3Vyc29yKSB7XG4gICAgICB2YXIgaGVhZFBvcyA9IGN1cnNvckNvb3JkcyhjbSwgZG9jLnNlbC5wcmltYXJ5KCkuaGVhZCwgXCJkaXZcIik7XG4gICAgICB2YXIgd3JhcE9mZiA9IGRpc3BsYXkud3JhcHBlci5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKSwgbGluZU9mZiA9IGRpc3BsYXkubGluZURpdi5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgIHJlc3VsdC50ZVRvcCA9IE1hdGgubWF4KDAsIE1hdGgubWluKGRpc3BsYXkud3JhcHBlci5jbGllbnRIZWlnaHQgLSAxMCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGhlYWRQb3MudG9wICsgbGluZU9mZi50b3AgLSB3cmFwT2ZmLnRvcCkpO1xuICAgICAgcmVzdWx0LnRlTGVmdCA9IE1hdGgubWF4KDAsIE1hdGgubWluKGRpc3BsYXkud3JhcHBlci5jbGllbnRXaWR0aCAtIDEwLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGhlYWRQb3MubGVmdCArIGxpbmVPZmYubGVmdCAtIHdyYXBPZmYubGVmdCkpO1xuICAgIH1cblxuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICBmdW5jdGlvbiB1cGRhdGVTZWxlY3Rpb24oY20sIGRyYXduKSB7XG4gICAgaWYgKCFkcmF3bikgZHJhd24gPSBkcmF3U2VsZWN0aW9uKGNtKTtcbiAgICByZW1vdmVDaGlsZHJlbkFuZEFkZChjbS5kaXNwbGF5LmN1cnNvckRpdiwgZHJhd24uY3Vyc29ycyk7XG4gICAgcmVtb3ZlQ2hpbGRyZW5BbmRBZGQoY20uZGlzcGxheS5zZWxlY3Rpb25EaXYsIGRyYXduLnNlbGVjdGlvbik7XG4gICAgaWYgKGRyYXduLnRlVG9wICE9IG51bGwpIHtcbiAgICAgIGNtLmRpc3BsYXkuaW5wdXREaXYuc3R5bGUudG9wID0gZHJhd24udGVUb3AgKyBcInB4XCI7XG4gICAgICBjbS5kaXNwbGF5LmlucHV0RGl2LnN0eWxlLmxlZnQgPSBkcmF3bi50ZUxlZnQgKyBcInB4XCI7XG4gICAgfVxuICB9XG5cbiAgLy8gRHJhd3MgYSBjdXJzb3IgZm9yIHRoZSBnaXZlbiByYW5nZVxuICBmdW5jdGlvbiBkcmF3U2VsZWN0aW9uQ3Vyc29yKGNtLCByYW5nZSwgb3V0cHV0KSB7XG4gICAgdmFyIHBvcyA9IGN1cnNvckNvb3JkcyhjbSwgcmFuZ2UuaGVhZCwgXCJkaXZcIiwgbnVsbCwgbnVsbCwgIWNtLm9wdGlvbnMuc2luZ2xlQ3Vyc29ySGVpZ2h0UGVyTGluZSk7XG5cbiAgICB2YXIgY3Vyc29yID0gb3V0cHV0LmFwcGVuZENoaWxkKGVsdChcImRpdlwiLCBcIlxcdTAwYTBcIiwgXCJDb2RlTWlycm9yLWN1cnNvclwiKSk7XG4gICAgY3Vyc29yLnN0eWxlLmxlZnQgPSBwb3MubGVmdCArIFwicHhcIjtcbiAgICBjdXJzb3Iuc3R5bGUudG9wID0gcG9zLnRvcCArIFwicHhcIjtcbiAgICBjdXJzb3Iuc3R5bGUuaGVpZ2h0ID0gTWF0aC5tYXgoMCwgcG9zLmJvdHRvbSAtIHBvcy50b3ApICogY20ub3B0aW9ucy5jdXJzb3JIZWlnaHQgKyBcInB4XCI7XG5cbiAgICBpZiAocG9zLm90aGVyKSB7XG4gICAgICAvLyBTZWNvbmRhcnkgY3Vyc29yLCBzaG93biB3aGVuIG9uIGEgJ2p1bXAnIGluIGJpLWRpcmVjdGlvbmFsIHRleHRcbiAgICAgIHZhciBvdGhlckN1cnNvciA9IG91dHB1dC5hcHBlbmRDaGlsZChlbHQoXCJkaXZcIiwgXCJcXHUwMGEwXCIsIFwiQ29kZU1pcnJvci1jdXJzb3IgQ29kZU1pcnJvci1zZWNvbmRhcnljdXJzb3JcIikpO1xuICAgICAgb3RoZXJDdXJzb3Iuc3R5bGUuZGlzcGxheSA9IFwiXCI7XG4gICAgICBvdGhlckN1cnNvci5zdHlsZS5sZWZ0ID0gcG9zLm90aGVyLmxlZnQgKyBcInB4XCI7XG4gICAgICBvdGhlckN1cnNvci5zdHlsZS50b3AgPSBwb3Mub3RoZXIudG9wICsgXCJweFwiO1xuICAgICAgb3RoZXJDdXJzb3Iuc3R5bGUuaGVpZ2h0ID0gKHBvcy5vdGhlci5ib3R0b20gLSBwb3Mub3RoZXIudG9wKSAqIC44NSArIFwicHhcIjtcbiAgICB9XG4gIH1cblxuICAvLyBEcmF3cyB0aGUgZ2l2ZW4gcmFuZ2UgYXMgYSBoaWdobGlnaHRlZCBzZWxlY3Rpb25cbiAgZnVuY3Rpb24gZHJhd1NlbGVjdGlvblJhbmdlKGNtLCByYW5nZSwgb3V0cHV0KSB7XG4gICAgdmFyIGRpc3BsYXkgPSBjbS5kaXNwbGF5LCBkb2MgPSBjbS5kb2M7XG4gICAgdmFyIGZyYWdtZW50ID0gZG9jdW1lbnQuY3JlYXRlRG9jdW1lbnRGcmFnbWVudCgpO1xuICAgIHZhciBwYWRkaW5nID0gcGFkZGluZ0goY20uZGlzcGxheSksIGxlZnRTaWRlID0gcGFkZGluZy5sZWZ0LCByaWdodFNpZGUgPSBkaXNwbGF5LmxpbmVTcGFjZS5vZmZzZXRXaWR0aCAtIHBhZGRpbmcucmlnaHQ7XG5cbiAgICBmdW5jdGlvbiBhZGQobGVmdCwgdG9wLCB3aWR0aCwgYm90dG9tKSB7XG4gICAgICBpZiAodG9wIDwgMCkgdG9wID0gMDtcbiAgICAgIHRvcCA9IE1hdGgucm91bmQodG9wKTtcbiAgICAgIGJvdHRvbSA9IE1hdGgucm91bmQoYm90dG9tKTtcbiAgICAgIGZyYWdtZW50LmFwcGVuZENoaWxkKGVsdChcImRpdlwiLCBudWxsLCBcIkNvZGVNaXJyb3Itc2VsZWN0ZWRcIiwgXCJwb3NpdGlvbjogYWJzb2x1dGU7IGxlZnQ6IFwiICsgbGVmdCArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJweDsgdG9wOiBcIiArIHRvcCArIFwicHg7IHdpZHRoOiBcIiArICh3aWR0aCA9PSBudWxsID8gcmlnaHRTaWRlIC0gbGVmdCA6IHdpZHRoKSArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJweDsgaGVpZ2h0OiBcIiArIChib3R0b20gLSB0b3ApICsgXCJweFwiKSk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZHJhd0ZvckxpbmUobGluZSwgZnJvbUFyZywgdG9BcmcpIHtcbiAgICAgIHZhciBsaW5lT2JqID0gZ2V0TGluZShkb2MsIGxpbmUpO1xuICAgICAgdmFyIGxpbmVMZW4gPSBsaW5lT2JqLnRleHQubGVuZ3RoO1xuICAgICAgdmFyIHN0YXJ0LCBlbmQ7XG4gICAgICBmdW5jdGlvbiBjb29yZHMoY2gsIGJpYXMpIHtcbiAgICAgICAgcmV0dXJuIGNoYXJDb29yZHMoY20sIFBvcyhsaW5lLCBjaCksIFwiZGl2XCIsIGxpbmVPYmosIGJpYXMpO1xuICAgICAgfVxuXG4gICAgICBpdGVyYXRlQmlkaVNlY3Rpb25zKGdldE9yZGVyKGxpbmVPYmopLCBmcm9tQXJnIHx8IDAsIHRvQXJnID09IG51bGwgPyBsaW5lTGVuIDogdG9BcmcsIGZ1bmN0aW9uKGZyb20sIHRvLCBkaXIpIHtcbiAgICAgICAgdmFyIGxlZnRQb3MgPSBjb29yZHMoZnJvbSwgXCJsZWZ0XCIpLCByaWdodFBvcywgbGVmdCwgcmlnaHQ7XG4gICAgICAgIGlmIChmcm9tID09IHRvKSB7XG4gICAgICAgICAgcmlnaHRQb3MgPSBsZWZ0UG9zO1xuICAgICAgICAgIGxlZnQgPSByaWdodCA9IGxlZnRQb3MubGVmdDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByaWdodFBvcyA9IGNvb3Jkcyh0byAtIDEsIFwicmlnaHRcIik7XG4gICAgICAgICAgaWYgKGRpciA9PSBcInJ0bFwiKSB7IHZhciB0bXAgPSBsZWZ0UG9zOyBsZWZ0UG9zID0gcmlnaHRQb3M7IHJpZ2h0UG9zID0gdG1wOyB9XG4gICAgICAgICAgbGVmdCA9IGxlZnRQb3MubGVmdDtcbiAgICAgICAgICByaWdodCA9IHJpZ2h0UG9zLnJpZ2h0O1xuICAgICAgICB9XG4gICAgICAgIGlmIChmcm9tQXJnID09IG51bGwgJiYgZnJvbSA9PSAwKSBsZWZ0ID0gbGVmdFNpZGU7XG4gICAgICAgIGlmIChyaWdodFBvcy50b3AgLSBsZWZ0UG9zLnRvcCA+IDMpIHsgLy8gRGlmZmVyZW50IGxpbmVzLCBkcmF3IHRvcCBwYXJ0XG4gICAgICAgICAgYWRkKGxlZnQsIGxlZnRQb3MudG9wLCBudWxsLCBsZWZ0UG9zLmJvdHRvbSk7XG4gICAgICAgICAgbGVmdCA9IGxlZnRTaWRlO1xuICAgICAgICAgIGlmIChsZWZ0UG9zLmJvdHRvbSA8IHJpZ2h0UG9zLnRvcCkgYWRkKGxlZnQsIGxlZnRQb3MuYm90dG9tLCBudWxsLCByaWdodFBvcy50b3ApO1xuICAgICAgICB9XG4gICAgICAgIGlmICh0b0FyZyA9PSBudWxsICYmIHRvID09IGxpbmVMZW4pIHJpZ2h0ID0gcmlnaHRTaWRlO1xuICAgICAgICBpZiAoIXN0YXJ0IHx8IGxlZnRQb3MudG9wIDwgc3RhcnQudG9wIHx8IGxlZnRQb3MudG9wID09IHN0YXJ0LnRvcCAmJiBsZWZ0UG9zLmxlZnQgPCBzdGFydC5sZWZ0KVxuICAgICAgICAgIHN0YXJ0ID0gbGVmdFBvcztcbiAgICAgICAgaWYgKCFlbmQgfHwgcmlnaHRQb3MuYm90dG9tID4gZW5kLmJvdHRvbSB8fCByaWdodFBvcy5ib3R0b20gPT0gZW5kLmJvdHRvbSAmJiByaWdodFBvcy5yaWdodCA+IGVuZC5yaWdodClcbiAgICAgICAgICBlbmQgPSByaWdodFBvcztcbiAgICAgICAgaWYgKGxlZnQgPCBsZWZ0U2lkZSArIDEpIGxlZnQgPSBsZWZ0U2lkZTtcbiAgICAgICAgYWRkKGxlZnQsIHJpZ2h0UG9zLnRvcCwgcmlnaHQgLSBsZWZ0LCByaWdodFBvcy5ib3R0b20pO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4ge3N0YXJ0OiBzdGFydCwgZW5kOiBlbmR9O1xuICAgIH1cblxuICAgIHZhciBzRnJvbSA9IHJhbmdlLmZyb20oKSwgc1RvID0gcmFuZ2UudG8oKTtcbiAgICBpZiAoc0Zyb20ubGluZSA9PSBzVG8ubGluZSkge1xuICAgICAgZHJhd0ZvckxpbmUoc0Zyb20ubGluZSwgc0Zyb20uY2gsIHNUby5jaCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHZhciBmcm9tTGluZSA9IGdldExpbmUoZG9jLCBzRnJvbS5saW5lKSwgdG9MaW5lID0gZ2V0TGluZShkb2MsIHNUby5saW5lKTtcbiAgICAgIHZhciBzaW5nbGVWTGluZSA9IHZpc3VhbExpbmUoZnJvbUxpbmUpID09IHZpc3VhbExpbmUodG9MaW5lKTtcbiAgICAgIHZhciBsZWZ0RW5kID0gZHJhd0ZvckxpbmUoc0Zyb20ubGluZSwgc0Zyb20uY2gsIHNpbmdsZVZMaW5lID8gZnJvbUxpbmUudGV4dC5sZW5ndGggKyAxIDogbnVsbCkuZW5kO1xuICAgICAgdmFyIHJpZ2h0U3RhcnQgPSBkcmF3Rm9yTGluZShzVG8ubGluZSwgc2luZ2xlVkxpbmUgPyAwIDogbnVsbCwgc1RvLmNoKS5zdGFydDtcbiAgICAgIGlmIChzaW5nbGVWTGluZSkge1xuICAgICAgICBpZiAobGVmdEVuZC50b3AgPCByaWdodFN0YXJ0LnRvcCAtIDIpIHtcbiAgICAgICAgICBhZGQobGVmdEVuZC5yaWdodCwgbGVmdEVuZC50b3AsIG51bGwsIGxlZnRFbmQuYm90dG9tKTtcbiAgICAgICAgICBhZGQobGVmdFNpZGUsIHJpZ2h0U3RhcnQudG9wLCByaWdodFN0YXJ0LmxlZnQsIHJpZ2h0U3RhcnQuYm90dG9tKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBhZGQobGVmdEVuZC5yaWdodCwgbGVmdEVuZC50b3AsIHJpZ2h0U3RhcnQubGVmdCAtIGxlZnRFbmQucmlnaHQsIGxlZnRFbmQuYm90dG9tKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKGxlZnRFbmQuYm90dG9tIDwgcmlnaHRTdGFydC50b3ApXG4gICAgICAgIGFkZChsZWZ0U2lkZSwgbGVmdEVuZC5ib3R0b20sIG51bGwsIHJpZ2h0U3RhcnQudG9wKTtcbiAgICB9XG5cbiAgICBvdXRwdXQuYXBwZW5kQ2hpbGQoZnJhZ21lbnQpO1xuICB9XG5cbiAgLy8gQ3Vyc29yLWJsaW5raW5nXG4gIGZ1bmN0aW9uIHJlc3RhcnRCbGluayhjbSkge1xuICAgIGlmICghY20uc3RhdGUuZm9jdXNlZCkgcmV0dXJuO1xuICAgIHZhciBkaXNwbGF5ID0gY20uZGlzcGxheTtcbiAgICBjbGVhckludGVydmFsKGRpc3BsYXkuYmxpbmtlcik7XG4gICAgdmFyIG9uID0gdHJ1ZTtcbiAgICBkaXNwbGF5LmN1cnNvckRpdi5zdHlsZS52aXNpYmlsaXR5ID0gXCJcIjtcbiAgICBpZiAoY20ub3B0aW9ucy5jdXJzb3JCbGlua1JhdGUgPiAwKVxuICAgICAgZGlzcGxheS5ibGlua2VyID0gc2V0SW50ZXJ2YWwoZnVuY3Rpb24oKSB7XG4gICAgICAgIGRpc3BsYXkuY3Vyc29yRGl2LnN0eWxlLnZpc2liaWxpdHkgPSAob24gPSAhb24pID8gXCJcIiA6IFwiaGlkZGVuXCI7XG4gICAgICB9LCBjbS5vcHRpb25zLmN1cnNvckJsaW5rUmF0ZSk7XG4gICAgZWxzZSBpZiAoY20ub3B0aW9ucy5jdXJzb3JCbGlua1JhdGUgPCAwKVxuICAgICAgZGlzcGxheS5jdXJzb3JEaXYuc3R5bGUudmlzaWJpbGl0eSA9IFwiaGlkZGVuXCI7XG4gIH1cblxuICAvLyBISUdITElHSFQgV09SS0VSXG5cbiAgZnVuY3Rpb24gc3RhcnRXb3JrZXIoY20sIHRpbWUpIHtcbiAgICBpZiAoY20uZG9jLm1vZGUuc3RhcnRTdGF0ZSAmJiBjbS5kb2MuZnJvbnRpZXIgPCBjbS5kaXNwbGF5LnZpZXdUbylcbiAgICAgIGNtLnN0YXRlLmhpZ2hsaWdodC5zZXQodGltZSwgYmluZChoaWdobGlnaHRXb3JrZXIsIGNtKSk7XG4gIH1cblxuICBmdW5jdGlvbiBoaWdobGlnaHRXb3JrZXIoY20pIHtcbiAgICB2YXIgZG9jID0gY20uZG9jO1xuICAgIGlmIChkb2MuZnJvbnRpZXIgPCBkb2MuZmlyc3QpIGRvYy5mcm9udGllciA9IGRvYy5maXJzdDtcbiAgICBpZiAoZG9jLmZyb250aWVyID49IGNtLmRpc3BsYXkudmlld1RvKSByZXR1cm47XG4gICAgdmFyIGVuZCA9ICtuZXcgRGF0ZSArIGNtLm9wdGlvbnMud29ya1RpbWU7XG4gICAgdmFyIHN0YXRlID0gY29weVN0YXRlKGRvYy5tb2RlLCBnZXRTdGF0ZUJlZm9yZShjbSwgZG9jLmZyb250aWVyKSk7XG4gICAgdmFyIGNoYW5nZWRMaW5lcyA9IFtdO1xuXG4gICAgZG9jLml0ZXIoZG9jLmZyb250aWVyLCBNYXRoLm1pbihkb2MuZmlyc3QgKyBkb2Muc2l6ZSwgY20uZGlzcGxheS52aWV3VG8gKyA1MDApLCBmdW5jdGlvbihsaW5lKSB7XG4gICAgICBpZiAoZG9jLmZyb250aWVyID49IGNtLmRpc3BsYXkudmlld0Zyb20pIHsgLy8gVmlzaWJsZVxuICAgICAgICB2YXIgb2xkU3R5bGVzID0gbGluZS5zdHlsZXM7XG4gICAgICAgIHZhciBoaWdobGlnaHRlZCA9IGhpZ2hsaWdodExpbmUoY20sIGxpbmUsIHN0YXRlLCB0cnVlKTtcbiAgICAgICAgbGluZS5zdHlsZXMgPSBoaWdobGlnaHRlZC5zdHlsZXM7XG4gICAgICAgIHZhciBvbGRDbHMgPSBsaW5lLnN0eWxlQ2xhc3NlcywgbmV3Q2xzID0gaGlnaGxpZ2h0ZWQuY2xhc3NlcztcbiAgICAgICAgaWYgKG5ld0NscykgbGluZS5zdHlsZUNsYXNzZXMgPSBuZXdDbHM7XG4gICAgICAgIGVsc2UgaWYgKG9sZENscykgbGluZS5zdHlsZUNsYXNzZXMgPSBudWxsO1xuICAgICAgICB2YXIgaXNjaGFuZ2UgPSAhb2xkU3R5bGVzIHx8IG9sZFN0eWxlcy5sZW5ndGggIT0gbGluZS5zdHlsZXMubGVuZ3RoIHx8XG4gICAgICAgICAgb2xkQ2xzICE9IG5ld0NscyAmJiAoIW9sZENscyB8fCAhbmV3Q2xzIHx8IG9sZENscy5iZ0NsYXNzICE9IG5ld0Nscy5iZ0NsYXNzIHx8IG9sZENscy50ZXh0Q2xhc3MgIT0gbmV3Q2xzLnRleHRDbGFzcyk7XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyAhaXNjaGFuZ2UgJiYgaSA8IG9sZFN0eWxlcy5sZW5ndGg7ICsraSkgaXNjaGFuZ2UgPSBvbGRTdHlsZXNbaV0gIT0gbGluZS5zdHlsZXNbaV07XG4gICAgICAgIGlmIChpc2NoYW5nZSkgY2hhbmdlZExpbmVzLnB1c2goZG9jLmZyb250aWVyKTtcbiAgICAgICAgbGluZS5zdGF0ZUFmdGVyID0gY29weVN0YXRlKGRvYy5tb2RlLCBzdGF0ZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwcm9jZXNzTGluZShjbSwgbGluZS50ZXh0LCBzdGF0ZSk7XG4gICAgICAgIGxpbmUuc3RhdGVBZnRlciA9IGRvYy5mcm9udGllciAlIDUgPT0gMCA/IGNvcHlTdGF0ZShkb2MubW9kZSwgc3RhdGUpIDogbnVsbDtcbiAgICAgIH1cbiAgICAgICsrZG9jLmZyb250aWVyO1xuICAgICAgaWYgKCtuZXcgRGF0ZSA+IGVuZCkge1xuICAgICAgICBzdGFydFdvcmtlcihjbSwgY20ub3B0aW9ucy53b3JrRGVsYXkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBpZiAoY2hhbmdlZExpbmVzLmxlbmd0aCkgcnVuSW5PcChjbSwgZnVuY3Rpb24oKSB7XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGNoYW5nZWRMaW5lcy5sZW5ndGg7IGkrKylcbiAgICAgICAgcmVnTGluZUNoYW5nZShjbSwgY2hhbmdlZExpbmVzW2ldLCBcInRleHRcIik7XG4gICAgfSk7XG4gIH1cblxuICAvLyBGaW5kcyB0aGUgbGluZSB0byBzdGFydCB3aXRoIHdoZW4gc3RhcnRpbmcgYSBwYXJzZS4gVHJpZXMgdG9cbiAgLy8gZmluZCBhIGxpbmUgd2l0aCBhIHN0YXRlQWZ0ZXIsIHNvIHRoYXQgaXQgY2FuIHN0YXJ0IHdpdGggYVxuICAvLyB2YWxpZCBzdGF0ZS4gSWYgdGhhdCBmYWlscywgaXQgcmV0dXJucyB0aGUgbGluZSB3aXRoIHRoZVxuICAvLyBzbWFsbGVzdCBpbmRlbnRhdGlvbiwgd2hpY2ggdGVuZHMgdG8gbmVlZCB0aGUgbGVhc3QgY29udGV4dCB0b1xuICAvLyBwYXJzZSBjb3JyZWN0bHkuXG4gIGZ1bmN0aW9uIGZpbmRTdGFydExpbmUoY20sIG4sIHByZWNpc2UpIHtcbiAgICB2YXIgbWluaW5kZW50LCBtaW5saW5lLCBkb2MgPSBjbS5kb2M7XG4gICAgdmFyIGxpbSA9IHByZWNpc2UgPyAtMSA6IG4gLSAoY20uZG9jLm1vZGUuaW5uZXJNb2RlID8gMTAwMCA6IDEwMCk7XG4gICAgZm9yICh2YXIgc2VhcmNoID0gbjsgc2VhcmNoID4gbGltOyAtLXNlYXJjaCkge1xuICAgICAgaWYgKHNlYXJjaCA8PSBkb2MuZmlyc3QpIHJldHVybiBkb2MuZmlyc3Q7XG4gICAgICB2YXIgbGluZSA9IGdldExpbmUoZG9jLCBzZWFyY2ggLSAxKTtcbiAgICAgIGlmIChsaW5lLnN0YXRlQWZ0ZXIgJiYgKCFwcmVjaXNlIHx8IHNlYXJjaCA8PSBkb2MuZnJvbnRpZXIpKSByZXR1cm4gc2VhcmNoO1xuICAgICAgdmFyIGluZGVudGVkID0gY291bnRDb2x1bW4obGluZS50ZXh0LCBudWxsLCBjbS5vcHRpb25zLnRhYlNpemUpO1xuICAgICAgaWYgKG1pbmxpbmUgPT0gbnVsbCB8fCBtaW5pbmRlbnQgPiBpbmRlbnRlZCkge1xuICAgICAgICBtaW5saW5lID0gc2VhcmNoIC0gMTtcbiAgICAgICAgbWluaW5kZW50ID0gaW5kZW50ZWQ7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBtaW5saW5lO1xuICB9XG5cbiAgZnVuY3Rpb24gZ2V0U3RhdGVCZWZvcmUoY20sIG4sIHByZWNpc2UpIHtcbiAgICB2YXIgZG9jID0gY20uZG9jLCBkaXNwbGF5ID0gY20uZGlzcGxheTtcbiAgICBpZiAoIWRvYy5tb2RlLnN0YXJ0U3RhdGUpIHJldHVybiB0cnVlO1xuICAgIHZhciBwb3MgPSBmaW5kU3RhcnRMaW5lKGNtLCBuLCBwcmVjaXNlKSwgc3RhdGUgPSBwb3MgPiBkb2MuZmlyc3QgJiYgZ2V0TGluZShkb2MsIHBvcy0xKS5zdGF0ZUFmdGVyO1xuICAgIGlmICghc3RhdGUpIHN0YXRlID0gc3RhcnRTdGF0ZShkb2MubW9kZSk7XG4gICAgZWxzZSBzdGF0ZSA9IGNvcHlTdGF0ZShkb2MubW9kZSwgc3RhdGUpO1xuICAgIGRvYy5pdGVyKHBvcywgbiwgZnVuY3Rpb24obGluZSkge1xuICAgICAgcHJvY2Vzc0xpbmUoY20sIGxpbmUudGV4dCwgc3RhdGUpO1xuICAgICAgdmFyIHNhdmUgPSBwb3MgPT0gbiAtIDEgfHwgcG9zICUgNSA9PSAwIHx8IHBvcyA+PSBkaXNwbGF5LnZpZXdGcm9tICYmIHBvcyA8IGRpc3BsYXkudmlld1RvO1xuICAgICAgbGluZS5zdGF0ZUFmdGVyID0gc2F2ZSA/IGNvcHlTdGF0ZShkb2MubW9kZSwgc3RhdGUpIDogbnVsbDtcbiAgICAgICsrcG9zO1xuICAgIH0pO1xuICAgIGlmIChwcmVjaXNlKSBkb2MuZnJvbnRpZXIgPSBwb3M7XG4gICAgcmV0dXJuIHN0YXRlO1xuICB9XG5cbiAgLy8gUE9TSVRJT04gTUVBU1VSRU1FTlRcblxuICBmdW5jdGlvbiBwYWRkaW5nVG9wKGRpc3BsYXkpIHtyZXR1cm4gZGlzcGxheS5saW5lU3BhY2Uub2Zmc2V0VG9wO31cbiAgZnVuY3Rpb24gcGFkZGluZ1ZlcnQoZGlzcGxheSkge3JldHVybiBkaXNwbGF5Lm1vdmVyLm9mZnNldEhlaWdodCAtIGRpc3BsYXkubGluZVNwYWNlLm9mZnNldEhlaWdodDt9XG4gIGZ1bmN0aW9uIHBhZGRpbmdIKGRpc3BsYXkpIHtcbiAgICBpZiAoZGlzcGxheS5jYWNoZWRQYWRkaW5nSCkgcmV0dXJuIGRpc3BsYXkuY2FjaGVkUGFkZGluZ0g7XG4gICAgdmFyIGUgPSByZW1vdmVDaGlsZHJlbkFuZEFkZChkaXNwbGF5Lm1lYXN1cmUsIGVsdChcInByZVwiLCBcInhcIikpO1xuICAgIHZhciBzdHlsZSA9IHdpbmRvdy5nZXRDb21wdXRlZFN0eWxlID8gd2luZG93LmdldENvbXB1dGVkU3R5bGUoZSkgOiBlLmN1cnJlbnRTdHlsZTtcbiAgICB2YXIgZGF0YSA9IHtsZWZ0OiBwYXJzZUludChzdHlsZS5wYWRkaW5nTGVmdCksIHJpZ2h0OiBwYXJzZUludChzdHlsZS5wYWRkaW5nUmlnaHQpfTtcbiAgICBpZiAoIWlzTmFOKGRhdGEubGVmdCkgJiYgIWlzTmFOKGRhdGEucmlnaHQpKSBkaXNwbGF5LmNhY2hlZFBhZGRpbmdIID0gZGF0YTtcbiAgICByZXR1cm4gZGF0YTtcbiAgfVxuXG4gIC8vIEVuc3VyZSB0aGUgbGluZVZpZXcud3JhcHBpbmcuaGVpZ2h0cyBhcnJheSBpcyBwb3B1bGF0ZWQuIFRoaXMgaXNcbiAgLy8gYW4gYXJyYXkgb2YgYm90dG9tIG9mZnNldHMgZm9yIHRoZSBsaW5lcyB0aGF0IG1ha2UgdXAgYSBkcmF3blxuICAvLyBsaW5lLiBXaGVuIGxpbmVXcmFwcGluZyBpcyBvbiwgdGhlcmUgbWlnaHQgYmUgbW9yZSB0aGFuIG9uZVxuICAvLyBoZWlnaHQuXG4gIGZ1bmN0aW9uIGVuc3VyZUxpbmVIZWlnaHRzKGNtLCBsaW5lVmlldywgcmVjdCkge1xuICAgIHZhciB3cmFwcGluZyA9IGNtLm9wdGlvbnMubGluZVdyYXBwaW5nO1xuICAgIHZhciBjdXJXaWR0aCA9IHdyYXBwaW5nICYmIGNtLmRpc3BsYXkuc2Nyb2xsZXIuY2xpZW50V2lkdGg7XG4gICAgaWYgKCFsaW5lVmlldy5tZWFzdXJlLmhlaWdodHMgfHwgd3JhcHBpbmcgJiYgbGluZVZpZXcubWVhc3VyZS53aWR0aCAhPSBjdXJXaWR0aCkge1xuICAgICAgdmFyIGhlaWdodHMgPSBsaW5lVmlldy5tZWFzdXJlLmhlaWdodHMgPSBbXTtcbiAgICAgIGlmICh3cmFwcGluZykge1xuICAgICAgICBsaW5lVmlldy5tZWFzdXJlLndpZHRoID0gY3VyV2lkdGg7XG4gICAgICAgIHZhciByZWN0cyA9IGxpbmVWaWV3LnRleHQuZmlyc3RDaGlsZC5nZXRDbGllbnRSZWN0cygpO1xuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHJlY3RzLmxlbmd0aCAtIDE7IGkrKykge1xuICAgICAgICAgIHZhciBjdXIgPSByZWN0c1tpXSwgbmV4dCA9IHJlY3RzW2kgKyAxXTtcbiAgICAgICAgICBpZiAoTWF0aC5hYnMoY3VyLmJvdHRvbSAtIG5leHQuYm90dG9tKSA+IDIpXG4gICAgICAgICAgICBoZWlnaHRzLnB1c2goKGN1ci5ib3R0b20gKyBuZXh0LnRvcCkgLyAyIC0gcmVjdC50b3ApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBoZWlnaHRzLnB1c2gocmVjdC5ib3R0b20gLSByZWN0LnRvcCk7XG4gICAgfVxuICB9XG5cbiAgLy8gRmluZCBhIGxpbmUgbWFwIChtYXBwaW5nIGNoYXJhY3RlciBvZmZzZXRzIHRvIHRleHQgbm9kZXMpIGFuZCBhXG4gIC8vIG1lYXN1cmVtZW50IGNhY2hlIGZvciB0aGUgZ2l2ZW4gbGluZSBudW1iZXIuIChBIGxpbmUgdmlldyBtaWdodFxuICAvLyBjb250YWluIG11bHRpcGxlIGxpbmVzIHdoZW4gY29sbGFwc2VkIHJhbmdlcyBhcmUgcHJlc2VudC4pXG4gIGZ1bmN0aW9uIG1hcEZyb21MaW5lVmlldyhsaW5lVmlldywgbGluZSwgbGluZU4pIHtcbiAgICBpZiAobGluZVZpZXcubGluZSA9PSBsaW5lKVxuICAgICAgcmV0dXJuIHttYXA6IGxpbmVWaWV3Lm1lYXN1cmUubWFwLCBjYWNoZTogbGluZVZpZXcubWVhc3VyZS5jYWNoZX07XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsaW5lVmlldy5yZXN0Lmxlbmd0aDsgaSsrKVxuICAgICAgaWYgKGxpbmVWaWV3LnJlc3RbaV0gPT0gbGluZSlcbiAgICAgICAgcmV0dXJuIHttYXA6IGxpbmVWaWV3Lm1lYXN1cmUubWFwc1tpXSwgY2FjaGU6IGxpbmVWaWV3Lm1lYXN1cmUuY2FjaGVzW2ldfTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxpbmVWaWV3LnJlc3QubGVuZ3RoOyBpKyspXG4gICAgICBpZiAobGluZU5vKGxpbmVWaWV3LnJlc3RbaV0pID4gbGluZU4pXG4gICAgICAgIHJldHVybiB7bWFwOiBsaW5lVmlldy5tZWFzdXJlLm1hcHNbaV0sIGNhY2hlOiBsaW5lVmlldy5tZWFzdXJlLmNhY2hlc1tpXSwgYmVmb3JlOiB0cnVlfTtcbiAgfVxuXG4gIC8vIFJlbmRlciBhIGxpbmUgaW50byB0aGUgaGlkZGVuIG5vZGUgZGlzcGxheS5leHRlcm5hbE1lYXN1cmVkLiBVc2VkXG4gIC8vIHdoZW4gbWVhc3VyZW1lbnQgaXMgbmVlZGVkIGZvciBhIGxpbmUgdGhhdCdzIG5vdCBpbiB0aGUgdmlld3BvcnQuXG4gIGZ1bmN0aW9uIHVwZGF0ZUV4dGVybmFsTWVhc3VyZW1lbnQoY20sIGxpbmUpIHtcbiAgICBsaW5lID0gdmlzdWFsTGluZShsaW5lKTtcbiAgICB2YXIgbGluZU4gPSBsaW5lTm8obGluZSk7XG4gICAgdmFyIHZpZXcgPSBjbS5kaXNwbGF5LmV4dGVybmFsTWVhc3VyZWQgPSBuZXcgTGluZVZpZXcoY20uZG9jLCBsaW5lLCBsaW5lTik7XG4gICAgdmlldy5saW5lTiA9IGxpbmVOO1xuICAgIHZhciBidWlsdCA9IHZpZXcuYnVpbHQgPSBidWlsZExpbmVDb250ZW50KGNtLCB2aWV3KTtcbiAgICB2aWV3LnRleHQgPSBidWlsdC5wcmU7XG4gICAgcmVtb3ZlQ2hpbGRyZW5BbmRBZGQoY20uZGlzcGxheS5saW5lTWVhc3VyZSwgYnVpbHQucHJlKTtcbiAgICByZXR1cm4gdmlldztcbiAgfVxuXG4gIC8vIEdldCBhIHt0b3AsIGJvdHRvbSwgbGVmdCwgcmlnaHR9IGJveCAoaW4gbGluZS1sb2NhbCBjb29yZGluYXRlcylcbiAgLy8gZm9yIGEgZ2l2ZW4gY2hhcmFjdGVyLlxuICBmdW5jdGlvbiBtZWFzdXJlQ2hhcihjbSwgbGluZSwgY2gsIGJpYXMpIHtcbiAgICByZXR1cm4gbWVhc3VyZUNoYXJQcmVwYXJlZChjbSwgcHJlcGFyZU1lYXN1cmVGb3JMaW5lKGNtLCBsaW5lKSwgY2gsIGJpYXMpO1xuICB9XG5cbiAgLy8gRmluZCBhIGxpbmUgdmlldyB0aGF0IGNvcnJlc3BvbmRzIHRvIHRoZSBnaXZlbiBsaW5lIG51bWJlci5cbiAgZnVuY3Rpb24gZmluZFZpZXdGb3JMaW5lKGNtLCBsaW5lTikge1xuICAgIGlmIChsaW5lTiA+PSBjbS5kaXNwbGF5LnZpZXdGcm9tICYmIGxpbmVOIDwgY20uZGlzcGxheS52aWV3VG8pXG4gICAgICByZXR1cm4gY20uZGlzcGxheS52aWV3W2ZpbmRWaWV3SW5kZXgoY20sIGxpbmVOKV07XG4gICAgdmFyIGV4dCA9IGNtLmRpc3BsYXkuZXh0ZXJuYWxNZWFzdXJlZDtcbiAgICBpZiAoZXh0ICYmIGxpbmVOID49IGV4dC5saW5lTiAmJiBsaW5lTiA8IGV4dC5saW5lTiArIGV4dC5zaXplKVxuICAgICAgcmV0dXJuIGV4dDtcbiAgfVxuXG4gIC8vIE1lYXN1cmVtZW50IGNhbiBiZSBzcGxpdCBpbiB0d28gc3RlcHMsIHRoZSBzZXQtdXAgd29yayB0aGF0XG4gIC8vIGFwcGxpZXMgdG8gdGhlIHdob2xlIGxpbmUsIGFuZCB0aGUgbWVhc3VyZW1lbnQgb2YgdGhlIGFjdHVhbFxuICAvLyBjaGFyYWN0ZXIuIEZ1bmN0aW9ucyBsaWtlIGNvb3Jkc0NoYXIsIHRoYXQgbmVlZCB0byBkbyBhIGxvdCBvZlxuICAvLyBtZWFzdXJlbWVudHMgaW4gYSByb3csIGNhbiB0aHVzIGVuc3VyZSB0aGF0IHRoZSBzZXQtdXAgd29yayBpc1xuICAvLyBvbmx5IGRvbmUgb25jZS5cbiAgZnVuY3Rpb24gcHJlcGFyZU1lYXN1cmVGb3JMaW5lKGNtLCBsaW5lKSB7XG4gICAgdmFyIGxpbmVOID0gbGluZU5vKGxpbmUpO1xuICAgIHZhciB2aWV3ID0gZmluZFZpZXdGb3JMaW5lKGNtLCBsaW5lTik7XG4gICAgaWYgKHZpZXcgJiYgIXZpZXcudGV4dClcbiAgICAgIHZpZXcgPSBudWxsO1xuICAgIGVsc2UgaWYgKHZpZXcgJiYgdmlldy5jaGFuZ2VzKVxuICAgICAgdXBkYXRlTGluZUZvckNoYW5nZXMoY20sIHZpZXcsIGxpbmVOLCBnZXREaW1lbnNpb25zKGNtKSk7XG4gICAgaWYgKCF2aWV3KVxuICAgICAgdmlldyA9IHVwZGF0ZUV4dGVybmFsTWVhc3VyZW1lbnQoY20sIGxpbmUpO1xuXG4gICAgdmFyIGluZm8gPSBtYXBGcm9tTGluZVZpZXcodmlldywgbGluZSwgbGluZU4pO1xuICAgIHJldHVybiB7XG4gICAgICBsaW5lOiBsaW5lLCB2aWV3OiB2aWV3LCByZWN0OiBudWxsLFxuICAgICAgbWFwOiBpbmZvLm1hcCwgY2FjaGU6IGluZm8uY2FjaGUsIGJlZm9yZTogaW5mby5iZWZvcmUsXG4gICAgICBoYXNIZWlnaHRzOiBmYWxzZVxuICAgIH07XG4gIH1cblxuICAvLyBHaXZlbiBhIHByZXBhcmVkIG1lYXN1cmVtZW50IG9iamVjdCwgbWVhc3VyZXMgdGhlIHBvc2l0aW9uIG9mIGFuXG4gIC8vIGFjdHVhbCBjaGFyYWN0ZXIgKG9yIGZldGNoZXMgaXQgZnJvbSB0aGUgY2FjaGUpLlxuICBmdW5jdGlvbiBtZWFzdXJlQ2hhclByZXBhcmVkKGNtLCBwcmVwYXJlZCwgY2gsIGJpYXMsIHZhckhlaWdodCkge1xuICAgIGlmIChwcmVwYXJlZC5iZWZvcmUpIGNoID0gLTE7XG4gICAgdmFyIGtleSA9IGNoICsgKGJpYXMgfHwgXCJcIiksIGZvdW5kO1xuICAgIGlmIChwcmVwYXJlZC5jYWNoZS5oYXNPd25Qcm9wZXJ0eShrZXkpKSB7XG4gICAgICBmb3VuZCA9IHByZXBhcmVkLmNhY2hlW2tleV07XG4gICAgfSBlbHNlIHtcbiAgICAgIGlmICghcHJlcGFyZWQucmVjdClcbiAgICAgICAgcHJlcGFyZWQucmVjdCA9IHByZXBhcmVkLnZpZXcudGV4dC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgIGlmICghcHJlcGFyZWQuaGFzSGVpZ2h0cykge1xuICAgICAgICBlbnN1cmVMaW5lSGVpZ2h0cyhjbSwgcHJlcGFyZWQudmlldywgcHJlcGFyZWQucmVjdCk7XG4gICAgICAgIHByZXBhcmVkLmhhc0hlaWdodHMgPSB0cnVlO1xuICAgICAgfVxuICAgICAgZm91bmQgPSBtZWFzdXJlQ2hhcklubmVyKGNtLCBwcmVwYXJlZCwgY2gsIGJpYXMpO1xuICAgICAgaWYgKCFmb3VuZC5ib2d1cykgcHJlcGFyZWQuY2FjaGVba2V5XSA9IGZvdW5kO1xuICAgIH1cbiAgICByZXR1cm4ge2xlZnQ6IGZvdW5kLmxlZnQsIHJpZ2h0OiBmb3VuZC5yaWdodCxcbiAgICAgICAgICAgIHRvcDogdmFySGVpZ2h0ID8gZm91bmQucnRvcCA6IGZvdW5kLnRvcCxcbiAgICAgICAgICAgIGJvdHRvbTogdmFySGVpZ2h0ID8gZm91bmQucmJvdHRvbSA6IGZvdW5kLmJvdHRvbX07XG4gIH1cblxuICB2YXIgbnVsbFJlY3QgPSB7bGVmdDogMCwgcmlnaHQ6IDAsIHRvcDogMCwgYm90dG9tOiAwfTtcblxuICBmdW5jdGlvbiBtZWFzdXJlQ2hhcklubmVyKGNtLCBwcmVwYXJlZCwgY2gsIGJpYXMpIHtcbiAgICB2YXIgbWFwID0gcHJlcGFyZWQubWFwO1xuXG4gICAgdmFyIG5vZGUsIHN0YXJ0LCBlbmQsIGNvbGxhcHNlO1xuICAgIC8vIEZpcnN0LCBzZWFyY2ggdGhlIGxpbmUgbWFwIGZvciB0aGUgdGV4dCBub2RlIGNvcnJlc3BvbmRpbmcgdG8sXG4gICAgLy8gb3IgY2xvc2VzdCB0bywgdGhlIHRhcmdldCBjaGFyYWN0ZXIuXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBtYXAubGVuZ3RoOyBpICs9IDMpIHtcbiAgICAgIHZhciBtU3RhcnQgPSBtYXBbaV0sIG1FbmQgPSBtYXBbaSArIDFdO1xuICAgICAgaWYgKGNoIDwgbVN0YXJ0KSB7XG4gICAgICAgIHN0YXJ0ID0gMDsgZW5kID0gMTtcbiAgICAgICAgY29sbGFwc2UgPSBcImxlZnRcIjtcbiAgICAgIH0gZWxzZSBpZiAoY2ggPCBtRW5kKSB7XG4gICAgICAgIHN0YXJ0ID0gY2ggLSBtU3RhcnQ7XG4gICAgICAgIGVuZCA9IHN0YXJ0ICsgMTtcbiAgICAgIH0gZWxzZSBpZiAoaSA9PSBtYXAubGVuZ3RoIC0gMyB8fCBjaCA9PSBtRW5kICYmIG1hcFtpICsgM10gPiBjaCkge1xuICAgICAgICBlbmQgPSBtRW5kIC0gbVN0YXJ0O1xuICAgICAgICBzdGFydCA9IGVuZCAtIDE7XG4gICAgICAgIGlmIChjaCA+PSBtRW5kKSBjb2xsYXBzZSA9IFwicmlnaHRcIjtcbiAgICAgIH1cbiAgICAgIGlmIChzdGFydCAhPSBudWxsKSB7XG4gICAgICAgIG5vZGUgPSBtYXBbaSArIDJdO1xuICAgICAgICBpZiAobVN0YXJ0ID09IG1FbmQgJiYgYmlhcyA9PSAobm9kZS5pbnNlcnRMZWZ0ID8gXCJsZWZ0XCIgOiBcInJpZ2h0XCIpKVxuICAgICAgICAgIGNvbGxhcHNlID0gYmlhcztcbiAgICAgICAgaWYgKGJpYXMgPT0gXCJsZWZ0XCIgJiYgc3RhcnQgPT0gMClcbiAgICAgICAgICB3aGlsZSAoaSAmJiBtYXBbaSAtIDJdID09IG1hcFtpIC0gM10gJiYgbWFwW2kgLSAxXS5pbnNlcnRMZWZ0KSB7XG4gICAgICAgICAgICBub2RlID0gbWFwWyhpIC09IDMpICsgMl07XG4gICAgICAgICAgICBjb2xsYXBzZSA9IFwibGVmdFwiO1xuICAgICAgICAgIH1cbiAgICAgICAgaWYgKGJpYXMgPT0gXCJyaWdodFwiICYmIHN0YXJ0ID09IG1FbmQgLSBtU3RhcnQpXG4gICAgICAgICAgd2hpbGUgKGkgPCBtYXAubGVuZ3RoIC0gMyAmJiBtYXBbaSArIDNdID09IG1hcFtpICsgNF0gJiYgIW1hcFtpICsgNV0uaW5zZXJ0TGVmdCkge1xuICAgICAgICAgICAgbm9kZSA9IG1hcFsoaSArPSAzKSArIDJdO1xuICAgICAgICAgICAgY29sbGFwc2UgPSBcInJpZ2h0XCI7XG4gICAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG5cbiAgICB2YXIgcmVjdDtcbiAgICBpZiAobm9kZS5ub2RlVHlwZSA9PSAzKSB7IC8vIElmIGl0IGlzIGEgdGV4dCBub2RlLCB1c2UgYSByYW5nZSB0byByZXRyaWV2ZSB0aGUgY29vcmRpbmF0ZXMuXG4gICAgICB3aGlsZSAoc3RhcnQgJiYgaXNFeHRlbmRpbmdDaGFyKHByZXBhcmVkLmxpbmUudGV4dC5jaGFyQXQobVN0YXJ0ICsgc3RhcnQpKSkgLS1zdGFydDtcbiAgICAgIHdoaWxlIChtU3RhcnQgKyBlbmQgPCBtRW5kICYmIGlzRXh0ZW5kaW5nQ2hhcihwcmVwYXJlZC5saW5lLnRleHQuY2hhckF0KG1TdGFydCArIGVuZCkpKSArK2VuZDtcbiAgICAgIGlmIChpZSAmJiBpZV92ZXJzaW9uIDwgOSAmJiBzdGFydCA9PSAwICYmIGVuZCA9PSBtRW5kIC0gbVN0YXJ0KSB7XG4gICAgICAgIHJlY3QgPSBub2RlLnBhcmVudE5vZGUuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgICB9IGVsc2UgaWYgKGllICYmIGNtLm9wdGlvbnMubGluZVdyYXBwaW5nKSB7XG4gICAgICAgIHZhciByZWN0cyA9IHJhbmdlKG5vZGUsIHN0YXJ0LCBlbmQpLmdldENsaWVudFJlY3RzKCk7XG4gICAgICAgIGlmIChyZWN0cy5sZW5ndGgpXG4gICAgICAgICAgcmVjdCA9IHJlY3RzW2JpYXMgPT0gXCJyaWdodFwiID8gcmVjdHMubGVuZ3RoIC0gMSA6IDBdO1xuICAgICAgICBlbHNlXG4gICAgICAgICAgcmVjdCA9IG51bGxSZWN0O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmVjdCA9IHJhbmdlKG5vZGUsIHN0YXJ0LCBlbmQpLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpIHx8IG51bGxSZWN0O1xuICAgICAgfVxuICAgIH0gZWxzZSB7IC8vIElmIGl0IGlzIGEgd2lkZ2V0LCBzaW1wbHkgZ2V0IHRoZSBib3ggZm9yIHRoZSB3aG9sZSB3aWRnZXQuXG4gICAgICBpZiAoc3RhcnQgPiAwKSBjb2xsYXBzZSA9IGJpYXMgPSBcInJpZ2h0XCI7XG4gICAgICB2YXIgcmVjdHM7XG4gICAgICBpZiAoY20ub3B0aW9ucy5saW5lV3JhcHBpbmcgJiYgKHJlY3RzID0gbm9kZS5nZXRDbGllbnRSZWN0cygpKS5sZW5ndGggPiAxKVxuICAgICAgICByZWN0ID0gcmVjdHNbYmlhcyA9PSBcInJpZ2h0XCIgPyByZWN0cy5sZW5ndGggLSAxIDogMF07XG4gICAgICBlbHNlXG4gICAgICAgIHJlY3QgPSBub2RlLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgIH1cbiAgICBpZiAoaWUgJiYgaWVfdmVyc2lvbiA8IDkgJiYgIXN0YXJ0ICYmICghcmVjdCB8fCAhcmVjdC5sZWZ0ICYmICFyZWN0LnJpZ2h0KSkge1xuICAgICAgdmFyIHJTcGFuID0gbm9kZS5wYXJlbnROb2RlLmdldENsaWVudFJlY3RzKClbMF07XG4gICAgICBpZiAoclNwYW4pXG4gICAgICAgIHJlY3QgPSB7bGVmdDogclNwYW4ubGVmdCwgcmlnaHQ6IHJTcGFuLmxlZnQgKyBjaGFyV2lkdGgoY20uZGlzcGxheSksIHRvcDogclNwYW4udG9wLCBib3R0b206IHJTcGFuLmJvdHRvbX07XG4gICAgICBlbHNlXG4gICAgICAgIHJlY3QgPSBudWxsUmVjdDtcbiAgICB9XG5cbiAgICBpZiAoaWUgJiYgaWVfdmVyc2lvbiA8IDExKSByZWN0ID0gbWF5YmVVcGRhdGVSZWN0Rm9yWm9vbWluZyhjbS5kaXNwbGF5Lm1lYXN1cmUsIHJlY3QpO1xuXG4gICAgdmFyIHJ0b3AgPSByZWN0LnRvcCAtIHByZXBhcmVkLnJlY3QudG9wLCByYm90ID0gcmVjdC5ib3R0b20gLSBwcmVwYXJlZC5yZWN0LnRvcDtcbiAgICB2YXIgbWlkID0gKHJ0b3AgKyByYm90KSAvIDI7XG4gICAgdmFyIGhlaWdodHMgPSBwcmVwYXJlZC52aWV3Lm1lYXN1cmUuaGVpZ2h0cztcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGhlaWdodHMubGVuZ3RoIC0gMTsgaSsrKVxuICAgICAgaWYgKG1pZCA8IGhlaWdodHNbaV0pIGJyZWFrO1xuICAgIHZhciB0b3AgPSBpID8gaGVpZ2h0c1tpIC0gMV0gOiAwLCBib3QgPSBoZWlnaHRzW2ldO1xuICAgIHZhciByZXN1bHQgPSB7bGVmdDogKGNvbGxhcHNlID09IFwicmlnaHRcIiA/IHJlY3QucmlnaHQgOiByZWN0LmxlZnQpIC0gcHJlcGFyZWQucmVjdC5sZWZ0LFxuICAgICAgICAgICAgICAgICAgcmlnaHQ6IChjb2xsYXBzZSA9PSBcImxlZnRcIiA/IHJlY3QubGVmdCA6IHJlY3QucmlnaHQpIC0gcHJlcGFyZWQucmVjdC5sZWZ0LFxuICAgICAgICAgICAgICAgICAgdG9wOiB0b3AsIGJvdHRvbTogYm90fTtcbiAgICBpZiAoIXJlY3QubGVmdCAmJiAhcmVjdC5yaWdodCkgcmVzdWx0LmJvZ3VzID0gdHJ1ZTtcbiAgICBpZiAoIWNtLm9wdGlvbnMuc2luZ2xlQ3Vyc29ySGVpZ2h0UGVyTGluZSkgeyByZXN1bHQucnRvcCA9IHJ0b3A7IHJlc3VsdC5yYm90dG9tID0gcmJvdDsgfVxuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIC8vIFdvcmsgYXJvdW5kIHByb2JsZW0gd2l0aCBib3VuZGluZyBjbGllbnQgcmVjdHMgb24gcmFuZ2VzIGJlaW5nXG4gIC8vIHJldHVybmVkIGluY29ycmVjdGx5IHdoZW4gem9vbWVkIG9uIElFMTAgYW5kIGJlbG93LlxuICBmdW5jdGlvbiBtYXliZVVwZGF0ZVJlY3RGb3Jab29taW5nKG1lYXN1cmUsIHJlY3QpIHtcbiAgICBpZiAoIXdpbmRvdy5zY3JlZW4gfHwgc2NyZWVuLmxvZ2ljYWxYRFBJID09IG51bGwgfHxcbiAgICAgICAgc2NyZWVuLmxvZ2ljYWxYRFBJID09IHNjcmVlbi5kZXZpY2VYRFBJIHx8ICFoYXNCYWRab29tZWRSZWN0cyhtZWFzdXJlKSlcbiAgICAgIHJldHVybiByZWN0O1xuICAgIHZhciBzY2FsZVggPSBzY3JlZW4ubG9naWNhbFhEUEkgLyBzY3JlZW4uZGV2aWNlWERQSTtcbiAgICB2YXIgc2NhbGVZID0gc2NyZWVuLmxvZ2ljYWxZRFBJIC8gc2NyZWVuLmRldmljZVlEUEk7XG4gICAgcmV0dXJuIHtsZWZ0OiByZWN0LmxlZnQgKiBzY2FsZVgsIHJpZ2h0OiByZWN0LnJpZ2h0ICogc2NhbGVYLFxuICAgICAgICAgICAgdG9wOiByZWN0LnRvcCAqIHNjYWxlWSwgYm90dG9tOiByZWN0LmJvdHRvbSAqIHNjYWxlWX07XG4gIH1cblxuICBmdW5jdGlvbiBjbGVhckxpbmVNZWFzdXJlbWVudENhY2hlRm9yKGxpbmVWaWV3KSB7XG4gICAgaWYgKGxpbmVWaWV3Lm1lYXN1cmUpIHtcbiAgICAgIGxpbmVWaWV3Lm1lYXN1cmUuY2FjaGUgPSB7fTtcbiAgICAgIGxpbmVWaWV3Lm1lYXN1cmUuaGVpZ2h0cyA9IG51bGw7XG4gICAgICBpZiAobGluZVZpZXcucmVzdCkgZm9yICh2YXIgaSA9IDA7IGkgPCBsaW5lVmlldy5yZXN0Lmxlbmd0aDsgaSsrKVxuICAgICAgICBsaW5lVmlldy5tZWFzdXJlLmNhY2hlc1tpXSA9IHt9O1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGNsZWFyTGluZU1lYXN1cmVtZW50Q2FjaGUoY20pIHtcbiAgICBjbS5kaXNwbGF5LmV4dGVybmFsTWVhc3VyZSA9IG51bGw7XG4gICAgcmVtb3ZlQ2hpbGRyZW4oY20uZGlzcGxheS5saW5lTWVhc3VyZSk7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjbS5kaXNwbGF5LnZpZXcubGVuZ3RoOyBpKyspXG4gICAgICBjbGVhckxpbmVNZWFzdXJlbWVudENhY2hlRm9yKGNtLmRpc3BsYXkudmlld1tpXSk7XG4gIH1cblxuICBmdW5jdGlvbiBjbGVhckNhY2hlcyhjbSkge1xuICAgIGNsZWFyTGluZU1lYXN1cmVtZW50Q2FjaGUoY20pO1xuICAgIGNtLmRpc3BsYXkuY2FjaGVkQ2hhcldpZHRoID0gY20uZGlzcGxheS5jYWNoZWRUZXh0SGVpZ2h0ID0gY20uZGlzcGxheS5jYWNoZWRQYWRkaW5nSCA9IG51bGw7XG4gICAgaWYgKCFjbS5vcHRpb25zLmxpbmVXcmFwcGluZykgY20uZGlzcGxheS5tYXhMaW5lQ2hhbmdlZCA9IHRydWU7XG4gICAgY20uZGlzcGxheS5saW5lTnVtQ2hhcnMgPSBudWxsO1xuICB9XG5cbiAgZnVuY3Rpb24gcGFnZVNjcm9sbFgoKSB7IHJldHVybiB3aW5kb3cucGFnZVhPZmZzZXQgfHwgKGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCB8fCBkb2N1bWVudC5ib2R5KS5zY3JvbGxMZWZ0OyB9XG4gIGZ1bmN0aW9uIHBhZ2VTY3JvbGxZKCkgeyByZXR1cm4gd2luZG93LnBhZ2VZT2Zmc2V0IHx8IChkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQgfHwgZG9jdW1lbnQuYm9keSkuc2Nyb2xsVG9wOyB9XG5cbiAgLy8gQ29udmVydHMgYSB7dG9wLCBib3R0b20sIGxlZnQsIHJpZ2h0fSBib3ggZnJvbSBsaW5lLWxvY2FsXG4gIC8vIGNvb3JkaW5hdGVzIGludG8gYW5vdGhlciBjb29yZGluYXRlIHN5c3RlbS4gQ29udGV4dCBtYXkgYmUgb25lIG9mXG4gIC8vIFwibGluZVwiLCBcImRpdlwiIChkaXNwbGF5LmxpbmVEaXYpLCBcImxvY2FsXCIvbnVsbCAoZWRpdG9yKSwgb3IgXCJwYWdlXCIuXG4gIGZ1bmN0aW9uIGludG9Db29yZFN5c3RlbShjbSwgbGluZU9iaiwgcmVjdCwgY29udGV4dCkge1xuICAgIGlmIChsaW5lT2JqLndpZGdldHMpIGZvciAodmFyIGkgPSAwOyBpIDwgbGluZU9iai53aWRnZXRzLmxlbmd0aDsgKytpKSBpZiAobGluZU9iai53aWRnZXRzW2ldLmFib3ZlKSB7XG4gICAgICB2YXIgc2l6ZSA9IHdpZGdldEhlaWdodChsaW5lT2JqLndpZGdldHNbaV0pO1xuICAgICAgcmVjdC50b3AgKz0gc2l6ZTsgcmVjdC5ib3R0b20gKz0gc2l6ZTtcbiAgICB9XG4gICAgaWYgKGNvbnRleHQgPT0gXCJsaW5lXCIpIHJldHVybiByZWN0O1xuICAgIGlmICghY29udGV4dCkgY29udGV4dCA9IFwibG9jYWxcIjtcbiAgICB2YXIgeU9mZiA9IGhlaWdodEF0TGluZShsaW5lT2JqKTtcbiAgICBpZiAoY29udGV4dCA9PSBcImxvY2FsXCIpIHlPZmYgKz0gcGFkZGluZ1RvcChjbS5kaXNwbGF5KTtcbiAgICBlbHNlIHlPZmYgLT0gY20uZGlzcGxheS52aWV3T2Zmc2V0O1xuICAgIGlmIChjb250ZXh0ID09IFwicGFnZVwiIHx8IGNvbnRleHQgPT0gXCJ3aW5kb3dcIikge1xuICAgICAgdmFyIGxPZmYgPSBjbS5kaXNwbGF5LmxpbmVTcGFjZS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgIHlPZmYgKz0gbE9mZi50b3AgKyAoY29udGV4dCA9PSBcIndpbmRvd1wiID8gMCA6IHBhZ2VTY3JvbGxZKCkpO1xuICAgICAgdmFyIHhPZmYgPSBsT2ZmLmxlZnQgKyAoY29udGV4dCA9PSBcIndpbmRvd1wiID8gMCA6IHBhZ2VTY3JvbGxYKCkpO1xuICAgICAgcmVjdC5sZWZ0ICs9IHhPZmY7IHJlY3QucmlnaHQgKz0geE9mZjtcbiAgICB9XG4gICAgcmVjdC50b3AgKz0geU9mZjsgcmVjdC5ib3R0b20gKz0geU9mZjtcbiAgICByZXR1cm4gcmVjdDtcbiAgfVxuXG4gIC8vIENvdmVydHMgYSBib3ggZnJvbSBcImRpdlwiIGNvb3JkcyB0byBhbm90aGVyIGNvb3JkaW5hdGUgc3lzdGVtLlxuICAvLyBDb250ZXh0IG1heSBiZSBcIndpbmRvd1wiLCBcInBhZ2VcIiwgXCJkaXZcIiwgb3IgXCJsb2NhbFwiL251bGwuXG4gIGZ1bmN0aW9uIGZyb21Db29yZFN5c3RlbShjbSwgY29vcmRzLCBjb250ZXh0KSB7XG4gICAgaWYgKGNvbnRleHQgPT0gXCJkaXZcIikgcmV0dXJuIGNvb3JkcztcbiAgICB2YXIgbGVmdCA9IGNvb3Jkcy5sZWZ0LCB0b3AgPSBjb29yZHMudG9wO1xuICAgIC8vIEZpcnN0IG1vdmUgaW50byBcInBhZ2VcIiBjb29yZGluYXRlIHN5c3RlbVxuICAgIGlmIChjb250ZXh0ID09IFwicGFnZVwiKSB7XG4gICAgICBsZWZ0IC09IHBhZ2VTY3JvbGxYKCk7XG4gICAgICB0b3AgLT0gcGFnZVNjcm9sbFkoKTtcbiAgICB9IGVsc2UgaWYgKGNvbnRleHQgPT0gXCJsb2NhbFwiIHx8ICFjb250ZXh0KSB7XG4gICAgICB2YXIgbG9jYWxCb3ggPSBjbS5kaXNwbGF5LnNpemVyLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgbGVmdCArPSBsb2NhbEJveC5sZWZ0O1xuICAgICAgdG9wICs9IGxvY2FsQm94LnRvcDtcbiAgICB9XG5cbiAgICB2YXIgbGluZVNwYWNlQm94ID0gY20uZGlzcGxheS5saW5lU3BhY2UuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgcmV0dXJuIHtsZWZ0OiBsZWZ0IC0gbGluZVNwYWNlQm94LmxlZnQsIHRvcDogdG9wIC0gbGluZVNwYWNlQm94LnRvcH07XG4gIH1cblxuICBmdW5jdGlvbiBjaGFyQ29vcmRzKGNtLCBwb3MsIGNvbnRleHQsIGxpbmVPYmosIGJpYXMpIHtcbiAgICBpZiAoIWxpbmVPYmopIGxpbmVPYmogPSBnZXRMaW5lKGNtLmRvYywgcG9zLmxpbmUpO1xuICAgIHJldHVybiBpbnRvQ29vcmRTeXN0ZW0oY20sIGxpbmVPYmosIG1lYXN1cmVDaGFyKGNtLCBsaW5lT2JqLCBwb3MuY2gsIGJpYXMpLCBjb250ZXh0KTtcbiAgfVxuXG4gIC8vIFJldHVybnMgYSBib3ggZm9yIGEgZ2l2ZW4gY3Vyc29yIHBvc2l0aW9uLCB3aGljaCBtYXkgaGF2ZSBhblxuICAvLyAnb3RoZXInIHByb3BlcnR5IGNvbnRhaW5pbmcgdGhlIHBvc2l0aW9uIG9mIHRoZSBzZWNvbmRhcnkgY3Vyc29yXG4gIC8vIG9uIGEgYmlkaSBib3VuZGFyeS5cbiAgZnVuY3Rpb24gY3Vyc29yQ29vcmRzKGNtLCBwb3MsIGNvbnRleHQsIGxpbmVPYmosIHByZXBhcmVkTWVhc3VyZSwgdmFySGVpZ2h0KSB7XG4gICAgbGluZU9iaiA9IGxpbmVPYmogfHwgZ2V0TGluZShjbS5kb2MsIHBvcy5saW5lKTtcbiAgICBpZiAoIXByZXBhcmVkTWVhc3VyZSkgcHJlcGFyZWRNZWFzdXJlID0gcHJlcGFyZU1lYXN1cmVGb3JMaW5lKGNtLCBsaW5lT2JqKTtcbiAgICBmdW5jdGlvbiBnZXQoY2gsIHJpZ2h0KSB7XG4gICAgICB2YXIgbSA9IG1lYXN1cmVDaGFyUHJlcGFyZWQoY20sIHByZXBhcmVkTWVhc3VyZSwgY2gsIHJpZ2h0ID8gXCJyaWdodFwiIDogXCJsZWZ0XCIsIHZhckhlaWdodCk7XG4gICAgICBpZiAocmlnaHQpIG0ubGVmdCA9IG0ucmlnaHQ7IGVsc2UgbS5yaWdodCA9IG0ubGVmdDtcbiAgICAgIHJldHVybiBpbnRvQ29vcmRTeXN0ZW0oY20sIGxpbmVPYmosIG0sIGNvbnRleHQpO1xuICAgIH1cbiAgICBmdW5jdGlvbiBnZXRCaWRpKGNoLCBwYXJ0UG9zKSB7XG4gICAgICB2YXIgcGFydCA9IG9yZGVyW3BhcnRQb3NdLCByaWdodCA9IHBhcnQubGV2ZWwgJSAyO1xuICAgICAgaWYgKGNoID09IGJpZGlMZWZ0KHBhcnQpICYmIHBhcnRQb3MgJiYgcGFydC5sZXZlbCA8IG9yZGVyW3BhcnRQb3MgLSAxXS5sZXZlbCkge1xuICAgICAgICBwYXJ0ID0gb3JkZXJbLS1wYXJ0UG9zXTtcbiAgICAgICAgY2ggPSBiaWRpUmlnaHQocGFydCkgLSAocGFydC5sZXZlbCAlIDIgPyAwIDogMSk7XG4gICAgICAgIHJpZ2h0ID0gdHJ1ZTtcbiAgICAgIH0gZWxzZSBpZiAoY2ggPT0gYmlkaVJpZ2h0KHBhcnQpICYmIHBhcnRQb3MgPCBvcmRlci5sZW5ndGggLSAxICYmIHBhcnQubGV2ZWwgPCBvcmRlcltwYXJ0UG9zICsgMV0ubGV2ZWwpIHtcbiAgICAgICAgcGFydCA9IG9yZGVyWysrcGFydFBvc107XG4gICAgICAgIGNoID0gYmlkaUxlZnQocGFydCkgLSBwYXJ0LmxldmVsICUgMjtcbiAgICAgICAgcmlnaHQgPSBmYWxzZTtcbiAgICAgIH1cbiAgICAgIGlmIChyaWdodCAmJiBjaCA9PSBwYXJ0LnRvICYmIGNoID4gcGFydC5mcm9tKSByZXR1cm4gZ2V0KGNoIC0gMSk7XG4gICAgICByZXR1cm4gZ2V0KGNoLCByaWdodCk7XG4gICAgfVxuICAgIHZhciBvcmRlciA9IGdldE9yZGVyKGxpbmVPYmopLCBjaCA9IHBvcy5jaDtcbiAgICBpZiAoIW9yZGVyKSByZXR1cm4gZ2V0KGNoKTtcbiAgICB2YXIgcGFydFBvcyA9IGdldEJpZGlQYXJ0QXQob3JkZXIsIGNoKTtcbiAgICB2YXIgdmFsID0gZ2V0QmlkaShjaCwgcGFydFBvcyk7XG4gICAgaWYgKGJpZGlPdGhlciAhPSBudWxsKSB2YWwub3RoZXIgPSBnZXRCaWRpKGNoLCBiaWRpT3RoZXIpO1xuICAgIHJldHVybiB2YWw7XG4gIH1cblxuICAvLyBVc2VkIHRvIGNoZWFwbHkgZXN0aW1hdGUgdGhlIGNvb3JkaW5hdGVzIGZvciBhIHBvc2l0aW9uLiBVc2VkIGZvclxuICAvLyBpbnRlcm1lZGlhdGUgc2Nyb2xsIHVwZGF0ZXMuXG4gIGZ1bmN0aW9uIGVzdGltYXRlQ29vcmRzKGNtLCBwb3MpIHtcbiAgICB2YXIgbGVmdCA9IDAsIHBvcyA9IGNsaXBQb3MoY20uZG9jLCBwb3MpO1xuICAgIGlmICghY20ub3B0aW9ucy5saW5lV3JhcHBpbmcpIGxlZnQgPSBjaGFyV2lkdGgoY20uZGlzcGxheSkgKiBwb3MuY2g7XG4gICAgdmFyIGxpbmVPYmogPSBnZXRMaW5lKGNtLmRvYywgcG9zLmxpbmUpO1xuICAgIHZhciB0b3AgPSBoZWlnaHRBdExpbmUobGluZU9iaikgKyBwYWRkaW5nVG9wKGNtLmRpc3BsYXkpO1xuICAgIHJldHVybiB7bGVmdDogbGVmdCwgcmlnaHQ6IGxlZnQsIHRvcDogdG9wLCBib3R0b206IHRvcCArIGxpbmVPYmouaGVpZ2h0fTtcbiAgfVxuXG4gIC8vIFBvc2l0aW9ucyByZXR1cm5lZCBieSBjb29yZHNDaGFyIGNvbnRhaW4gc29tZSBleHRyYSBpbmZvcm1hdGlvbi5cbiAgLy8geFJlbCBpcyB0aGUgcmVsYXRpdmUgeCBwb3NpdGlvbiBvZiB0aGUgaW5wdXQgY29vcmRpbmF0ZXMgY29tcGFyZWRcbiAgLy8gdG8gdGhlIGZvdW5kIHBvc2l0aW9uIChzbyB4UmVsID4gMCBtZWFucyB0aGUgY29vcmRpbmF0ZXMgYXJlIHRvXG4gIC8vIHRoZSByaWdodCBvZiB0aGUgY2hhcmFjdGVyIHBvc2l0aW9uLCBmb3IgZXhhbXBsZSkuIFdoZW4gb3V0c2lkZVxuICAvLyBpcyB0cnVlLCB0aGF0IG1lYW5zIHRoZSBjb29yZGluYXRlcyBsaWUgb3V0c2lkZSB0aGUgbGluZSdzXG4gIC8vIHZlcnRpY2FsIHJhbmdlLlxuICBmdW5jdGlvbiBQb3NXaXRoSW5mbyhsaW5lLCBjaCwgb3V0c2lkZSwgeFJlbCkge1xuICAgIHZhciBwb3MgPSBQb3MobGluZSwgY2gpO1xuICAgIHBvcy54UmVsID0geFJlbDtcbiAgICBpZiAob3V0c2lkZSkgcG9zLm91dHNpZGUgPSB0cnVlO1xuICAgIHJldHVybiBwb3M7XG4gIH1cblxuICAvLyBDb21wdXRlIHRoZSBjaGFyYWN0ZXIgcG9zaXRpb24gY2xvc2VzdCB0byB0aGUgZ2l2ZW4gY29vcmRpbmF0ZXMuXG4gIC8vIElucHV0IG11c3QgYmUgbGluZVNwYWNlLWxvY2FsIChcImRpdlwiIGNvb3JkaW5hdGUgc3lzdGVtKS5cbiAgZnVuY3Rpb24gY29vcmRzQ2hhcihjbSwgeCwgeSkge1xuICAgIHZhciBkb2MgPSBjbS5kb2M7XG4gICAgeSArPSBjbS5kaXNwbGF5LnZpZXdPZmZzZXQ7XG4gICAgaWYgKHkgPCAwKSByZXR1cm4gUG9zV2l0aEluZm8oZG9jLmZpcnN0LCAwLCB0cnVlLCAtMSk7XG4gICAgdmFyIGxpbmVOID0gbGluZUF0SGVpZ2h0KGRvYywgeSksIGxhc3QgPSBkb2MuZmlyc3QgKyBkb2Muc2l6ZSAtIDE7XG4gICAgaWYgKGxpbmVOID4gbGFzdClcbiAgICAgIHJldHVybiBQb3NXaXRoSW5mbyhkb2MuZmlyc3QgKyBkb2Muc2l6ZSAtIDEsIGdldExpbmUoZG9jLCBsYXN0KS50ZXh0Lmxlbmd0aCwgdHJ1ZSwgMSk7XG4gICAgaWYgKHggPCAwKSB4ID0gMDtcblxuICAgIHZhciBsaW5lT2JqID0gZ2V0TGluZShkb2MsIGxpbmVOKTtcbiAgICBmb3IgKDs7KSB7XG4gICAgICB2YXIgZm91bmQgPSBjb29yZHNDaGFySW5uZXIoY20sIGxpbmVPYmosIGxpbmVOLCB4LCB5KTtcbiAgICAgIHZhciBtZXJnZWQgPSBjb2xsYXBzZWRTcGFuQXRFbmQobGluZU9iaik7XG4gICAgICB2YXIgbWVyZ2VkUG9zID0gbWVyZ2VkICYmIG1lcmdlZC5maW5kKDAsIHRydWUpO1xuICAgICAgaWYgKG1lcmdlZCAmJiAoZm91bmQuY2ggPiBtZXJnZWRQb3MuZnJvbS5jaCB8fCBmb3VuZC5jaCA9PSBtZXJnZWRQb3MuZnJvbS5jaCAmJiBmb3VuZC54UmVsID4gMCkpXG4gICAgICAgIGxpbmVOID0gbGluZU5vKGxpbmVPYmogPSBtZXJnZWRQb3MudG8ubGluZSk7XG4gICAgICBlbHNlXG4gICAgICAgIHJldHVybiBmb3VuZDtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBjb29yZHNDaGFySW5uZXIoY20sIGxpbmVPYmosIGxpbmVObywgeCwgeSkge1xuICAgIHZhciBpbm5lck9mZiA9IHkgLSBoZWlnaHRBdExpbmUobGluZU9iaik7XG4gICAgdmFyIHdyb25nTGluZSA9IGZhbHNlLCBhZGp1c3QgPSAyICogY20uZGlzcGxheS53cmFwcGVyLmNsaWVudFdpZHRoO1xuICAgIHZhciBwcmVwYXJlZE1lYXN1cmUgPSBwcmVwYXJlTWVhc3VyZUZvckxpbmUoY20sIGxpbmVPYmopO1xuXG4gICAgZnVuY3Rpb24gZ2V0WChjaCkge1xuICAgICAgdmFyIHNwID0gY3Vyc29yQ29vcmRzKGNtLCBQb3MobGluZU5vLCBjaCksIFwibGluZVwiLCBsaW5lT2JqLCBwcmVwYXJlZE1lYXN1cmUpO1xuICAgICAgd3JvbmdMaW5lID0gdHJ1ZTtcbiAgICAgIGlmIChpbm5lck9mZiA+IHNwLmJvdHRvbSkgcmV0dXJuIHNwLmxlZnQgLSBhZGp1c3Q7XG4gICAgICBlbHNlIGlmIChpbm5lck9mZiA8IHNwLnRvcCkgcmV0dXJuIHNwLmxlZnQgKyBhZGp1c3Q7XG4gICAgICBlbHNlIHdyb25nTGluZSA9IGZhbHNlO1xuICAgICAgcmV0dXJuIHNwLmxlZnQ7XG4gICAgfVxuXG4gICAgdmFyIGJpZGkgPSBnZXRPcmRlcihsaW5lT2JqKSwgZGlzdCA9IGxpbmVPYmoudGV4dC5sZW5ndGg7XG4gICAgdmFyIGZyb20gPSBsaW5lTGVmdChsaW5lT2JqKSwgdG8gPSBsaW5lUmlnaHQobGluZU9iaik7XG4gICAgdmFyIGZyb21YID0gZ2V0WChmcm9tKSwgZnJvbU91dHNpZGUgPSB3cm9uZ0xpbmUsIHRvWCA9IGdldFgodG8pLCB0b091dHNpZGUgPSB3cm9uZ0xpbmU7XG5cbiAgICBpZiAoeCA+IHRvWCkgcmV0dXJuIFBvc1dpdGhJbmZvKGxpbmVObywgdG8sIHRvT3V0c2lkZSwgMSk7XG4gICAgLy8gRG8gYSBiaW5hcnkgc2VhcmNoIGJldHdlZW4gdGhlc2UgYm91bmRzLlxuICAgIGZvciAoOzspIHtcbiAgICAgIGlmIChiaWRpID8gdG8gPT0gZnJvbSB8fCB0byA9PSBtb3ZlVmlzdWFsbHkobGluZU9iaiwgZnJvbSwgMSkgOiB0byAtIGZyb20gPD0gMSkge1xuICAgICAgICB2YXIgY2ggPSB4IDwgZnJvbVggfHwgeCAtIGZyb21YIDw9IHRvWCAtIHggPyBmcm9tIDogdG87XG4gICAgICAgIHZhciB4RGlmZiA9IHggLSAoY2ggPT0gZnJvbSA/IGZyb21YIDogdG9YKTtcbiAgICAgICAgd2hpbGUgKGlzRXh0ZW5kaW5nQ2hhcihsaW5lT2JqLnRleHQuY2hhckF0KGNoKSkpICsrY2g7XG4gICAgICAgIHZhciBwb3MgPSBQb3NXaXRoSW5mbyhsaW5lTm8sIGNoLCBjaCA9PSBmcm9tID8gZnJvbU91dHNpZGUgOiB0b091dHNpZGUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICB4RGlmZiA8IC0xID8gLTEgOiB4RGlmZiA+IDEgPyAxIDogMCk7XG4gICAgICAgIHJldHVybiBwb3M7XG4gICAgICB9XG4gICAgICB2YXIgc3RlcCA9IE1hdGguY2VpbChkaXN0IC8gMiksIG1pZGRsZSA9IGZyb20gKyBzdGVwO1xuICAgICAgaWYgKGJpZGkpIHtcbiAgICAgICAgbWlkZGxlID0gZnJvbTtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBzdGVwOyArK2kpIG1pZGRsZSA9IG1vdmVWaXN1YWxseShsaW5lT2JqLCBtaWRkbGUsIDEpO1xuICAgICAgfVxuICAgICAgdmFyIG1pZGRsZVggPSBnZXRYKG1pZGRsZSk7XG4gICAgICBpZiAobWlkZGxlWCA+IHgpIHt0byA9IG1pZGRsZTsgdG9YID0gbWlkZGxlWDsgaWYgKHRvT3V0c2lkZSA9IHdyb25nTGluZSkgdG9YICs9IDEwMDA7IGRpc3QgPSBzdGVwO31cbiAgICAgIGVsc2Uge2Zyb20gPSBtaWRkbGU7IGZyb21YID0gbWlkZGxlWDsgZnJvbU91dHNpZGUgPSB3cm9uZ0xpbmU7IGRpc3QgLT0gc3RlcDt9XG4gICAgfVxuICB9XG5cbiAgdmFyIG1lYXN1cmVUZXh0O1xuICAvLyBDb21wdXRlIHRoZSBkZWZhdWx0IHRleHQgaGVpZ2h0LlxuICBmdW5jdGlvbiB0ZXh0SGVpZ2h0KGRpc3BsYXkpIHtcbiAgICBpZiAoZGlzcGxheS5jYWNoZWRUZXh0SGVpZ2h0ICE9IG51bGwpIHJldHVybiBkaXNwbGF5LmNhY2hlZFRleHRIZWlnaHQ7XG4gICAgaWYgKG1lYXN1cmVUZXh0ID09IG51bGwpIHtcbiAgICAgIG1lYXN1cmVUZXh0ID0gZWx0KFwicHJlXCIpO1xuICAgICAgLy8gTWVhc3VyZSBhIGJ1bmNoIG9mIGxpbmVzLCBmb3IgYnJvd3NlcnMgdGhhdCBjb21wdXRlXG4gICAgICAvLyBmcmFjdGlvbmFsIGhlaWdodHMuXG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IDQ5OyArK2kpIHtcbiAgICAgICAgbWVhc3VyZVRleHQuYXBwZW5kQ2hpbGQoZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUoXCJ4XCIpKTtcbiAgICAgICAgbWVhc3VyZVRleHQuYXBwZW5kQ2hpbGQoZWx0KFwiYnJcIikpO1xuICAgICAgfVxuICAgICAgbWVhc3VyZVRleHQuYXBwZW5kQ2hpbGQoZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUoXCJ4XCIpKTtcbiAgICB9XG4gICAgcmVtb3ZlQ2hpbGRyZW5BbmRBZGQoZGlzcGxheS5tZWFzdXJlLCBtZWFzdXJlVGV4dCk7XG4gICAgdmFyIGhlaWdodCA9IG1lYXN1cmVUZXh0Lm9mZnNldEhlaWdodCAvIDUwO1xuICAgIGlmIChoZWlnaHQgPiAzKSBkaXNwbGF5LmNhY2hlZFRleHRIZWlnaHQgPSBoZWlnaHQ7XG4gICAgcmVtb3ZlQ2hpbGRyZW4oZGlzcGxheS5tZWFzdXJlKTtcbiAgICByZXR1cm4gaGVpZ2h0IHx8IDE7XG4gIH1cblxuICAvLyBDb21wdXRlIHRoZSBkZWZhdWx0IGNoYXJhY3RlciB3aWR0aC5cbiAgZnVuY3Rpb24gY2hhcldpZHRoKGRpc3BsYXkpIHtcbiAgICBpZiAoZGlzcGxheS5jYWNoZWRDaGFyV2lkdGggIT0gbnVsbCkgcmV0dXJuIGRpc3BsYXkuY2FjaGVkQ2hhcldpZHRoO1xuICAgIHZhciBhbmNob3IgPSBlbHQoXCJzcGFuXCIsIFwieHh4eHh4eHh4eFwiKTtcbiAgICB2YXIgcHJlID0gZWx0KFwicHJlXCIsIFthbmNob3JdKTtcbiAgICByZW1vdmVDaGlsZHJlbkFuZEFkZChkaXNwbGF5Lm1lYXN1cmUsIHByZSk7XG4gICAgdmFyIHJlY3QgPSBhbmNob3IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCksIHdpZHRoID0gKHJlY3QucmlnaHQgLSByZWN0LmxlZnQpIC8gMTA7XG4gICAgaWYgKHdpZHRoID4gMikgZGlzcGxheS5jYWNoZWRDaGFyV2lkdGggPSB3aWR0aDtcbiAgICByZXR1cm4gd2lkdGggfHwgMTA7XG4gIH1cblxuICAvLyBPUEVSQVRJT05TXG5cbiAgLy8gT3BlcmF0aW9ucyBhcmUgdXNlZCB0byB3cmFwIGEgc2VyaWVzIG9mIGNoYW5nZXMgdG8gdGhlIGVkaXRvclxuICAvLyBzdGF0ZSBpbiBzdWNoIGEgd2F5IHRoYXQgZWFjaCBjaGFuZ2Ugd29uJ3QgaGF2ZSB0byB1cGRhdGUgdGhlXG4gIC8vIGN1cnNvciBhbmQgZGlzcGxheSAod2hpY2ggd291bGQgYmUgYXdrd2FyZCwgc2xvdywgYW5kXG4gIC8vIGVycm9yLXByb25lKS4gSW5zdGVhZCwgZGlzcGxheSB1cGRhdGVzIGFyZSBiYXRjaGVkIGFuZCB0aGVuIGFsbFxuICAvLyBjb21iaW5lZCBhbmQgZXhlY3V0ZWQgYXQgb25jZS5cblxuICB2YXIgb3BlcmF0aW9uR3JvdXAgPSBudWxsO1xuXG4gIHZhciBuZXh0T3BJZCA9IDA7XG4gIC8vIFN0YXJ0IGEgbmV3IG9wZXJhdGlvbi5cbiAgZnVuY3Rpb24gc3RhcnRPcGVyYXRpb24oY20pIHtcbiAgICBjbS5jdXJPcCA9IHtcbiAgICAgIGNtOiBjbSxcbiAgICAgIHZpZXdDaGFuZ2VkOiBmYWxzZSwgICAgICAvLyBGbGFnIHRoYXQgaW5kaWNhdGVzIHRoYXQgbGluZXMgbWlnaHQgbmVlZCB0byBiZSByZWRyYXduXG4gICAgICBzdGFydEhlaWdodDogY20uZG9jLmhlaWdodCwgLy8gVXNlZCB0byBkZXRlY3QgbmVlZCB0byB1cGRhdGUgc2Nyb2xsYmFyXG4gICAgICBmb3JjZVVwZGF0ZTogZmFsc2UsICAgICAgLy8gVXNlZCB0byBmb3JjZSBhIHJlZHJhd1xuICAgICAgdXBkYXRlSW5wdXQ6IG51bGwsICAgICAgIC8vIFdoZXRoZXIgdG8gcmVzZXQgdGhlIGlucHV0IHRleHRhcmVhXG4gICAgICB0eXBpbmc6IGZhbHNlLCAgICAgICAgICAgLy8gV2hldGhlciB0aGlzIHJlc2V0IHNob3VsZCBiZSBjYXJlZnVsIHRvIGxlYXZlIGV4aXN0aW5nIHRleHQgKGZvciBjb21wb3NpdGluZylcbiAgICAgIGNoYW5nZU9ianM6IG51bGwsICAgICAgICAvLyBBY2N1bXVsYXRlZCBjaGFuZ2VzLCBmb3IgZmlyaW5nIGNoYW5nZSBldmVudHNcbiAgICAgIGN1cnNvckFjdGl2aXR5SGFuZGxlcnM6IG51bGwsIC8vIFNldCBvZiBoYW5kbGVycyB0byBmaXJlIGN1cnNvckFjdGl2aXR5IG9uXG4gICAgICBjdXJzb3JBY3Rpdml0eUNhbGxlZDogMCwgLy8gVHJhY2tzIHdoaWNoIGN1cnNvckFjdGl2aXR5IGhhbmRsZXJzIGhhdmUgYmVlbiBjYWxsZWQgYWxyZWFkeVxuICAgICAgc2VsZWN0aW9uQ2hhbmdlZDogZmFsc2UsIC8vIFdoZXRoZXIgdGhlIHNlbGVjdGlvbiBuZWVkcyB0byBiZSByZWRyYXduXG4gICAgICB1cGRhdGVNYXhMaW5lOiBmYWxzZSwgICAgLy8gU2V0IHdoZW4gdGhlIHdpZGVzdCBsaW5lIG5lZWRzIHRvIGJlIGRldGVybWluZWQgYW5ld1xuICAgICAgc2Nyb2xsTGVmdDogbnVsbCwgc2Nyb2xsVG9wOiBudWxsLCAvLyBJbnRlcm1lZGlhdGUgc2Nyb2xsIHBvc2l0aW9uLCBub3QgcHVzaGVkIHRvIERPTSB5ZXRcbiAgICAgIHNjcm9sbFRvUG9zOiBudWxsLCAgICAgICAvLyBVc2VkIHRvIHNjcm9sbCB0byBhIHNwZWNpZmljIHBvc2l0aW9uXG4gICAgICBpZDogKytuZXh0T3BJZCAgICAgICAgICAgLy8gVW5pcXVlIElEXG4gICAgfTtcbiAgICBpZiAob3BlcmF0aW9uR3JvdXApIHtcbiAgICAgIG9wZXJhdGlvbkdyb3VwLm9wcy5wdXNoKGNtLmN1ck9wKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY20uY3VyT3Aub3duc0dyb3VwID0gb3BlcmF0aW9uR3JvdXAgPSB7XG4gICAgICAgIG9wczogW2NtLmN1ck9wXSxcbiAgICAgICAgZGVsYXllZENhbGxiYWNrczogW11cbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gZmlyZUNhbGxiYWNrc0Zvck9wcyhncm91cCkge1xuICAgIC8vIENhbGxzIGRlbGF5ZWQgY2FsbGJhY2tzIGFuZCBjdXJzb3JBY3Rpdml0eSBoYW5kbGVycyB1bnRpbCBub1xuICAgIC8vIG5ldyBvbmVzIGFwcGVhclxuICAgIHZhciBjYWxsYmFja3MgPSBncm91cC5kZWxheWVkQ2FsbGJhY2tzLCBpID0gMDtcbiAgICBkbyB7XG4gICAgICBmb3IgKDsgaSA8IGNhbGxiYWNrcy5sZW5ndGg7IGkrKylcbiAgICAgICAgY2FsbGJhY2tzW2ldKCk7XG4gICAgICBmb3IgKHZhciBqID0gMDsgaiA8IGdyb3VwLm9wcy5sZW5ndGg7IGorKykge1xuICAgICAgICB2YXIgb3AgPSBncm91cC5vcHNbal07XG4gICAgICAgIGlmIChvcC5jdXJzb3JBY3Rpdml0eUhhbmRsZXJzKVxuICAgICAgICAgIHdoaWxlIChvcC5jdXJzb3JBY3Rpdml0eUNhbGxlZCA8IG9wLmN1cnNvckFjdGl2aXR5SGFuZGxlcnMubGVuZ3RoKVxuICAgICAgICAgICAgb3AuY3Vyc29yQWN0aXZpdHlIYW5kbGVyc1tvcC5jdXJzb3JBY3Rpdml0eUNhbGxlZCsrXShvcC5jbSk7XG4gICAgICB9XG4gICAgfSB3aGlsZSAoaSA8IGNhbGxiYWNrcy5sZW5ndGgpO1xuICB9XG5cbiAgLy8gRmluaXNoIGFuIG9wZXJhdGlvbiwgdXBkYXRpbmcgdGhlIGRpc3BsYXkgYW5kIHNpZ25hbGxpbmcgZGVsYXllZCBldmVudHNcbiAgZnVuY3Rpb24gZW5kT3BlcmF0aW9uKGNtKSB7XG4gICAgdmFyIG9wID0gY20uY3VyT3AsIGdyb3VwID0gb3Aub3duc0dyb3VwO1xuICAgIGlmICghZ3JvdXApIHJldHVybjtcblxuICAgIHRyeSB7IGZpcmVDYWxsYmFja3NGb3JPcHMoZ3JvdXApOyB9XG4gICAgZmluYWxseSB7XG4gICAgICBvcGVyYXRpb25Hcm91cCA9IG51bGw7XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGdyb3VwLm9wcy5sZW5ndGg7IGkrKylcbiAgICAgICAgZ3JvdXAub3BzW2ldLmNtLmN1ck9wID0gbnVsbDtcbiAgICAgIGVuZE9wZXJhdGlvbnMoZ3JvdXApO1xuICAgIH1cbiAgfVxuXG4gIC8vIFRoZSBET00gdXBkYXRlcyBkb25lIHdoZW4gYW4gb3BlcmF0aW9uIGZpbmlzaGVzIGFyZSBiYXRjaGVkIHNvXG4gIC8vIHRoYXQgdGhlIG1pbmltdW0gbnVtYmVyIG9mIHJlbGF5b3V0cyBhcmUgcmVxdWlyZWQuXG4gIGZ1bmN0aW9uIGVuZE9wZXJhdGlvbnMoZ3JvdXApIHtcbiAgICB2YXIgb3BzID0gZ3JvdXAub3BzO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgb3BzLmxlbmd0aDsgaSsrKSAvLyBSZWFkIERPTVxuICAgICAgZW5kT3BlcmF0aW9uX1IxKG9wc1tpXSk7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBvcHMubGVuZ3RoOyBpKyspIC8vIFdyaXRlIERPTSAobWF5YmUpXG4gICAgICBlbmRPcGVyYXRpb25fVzEob3BzW2ldKTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IG9wcy5sZW5ndGg7IGkrKykgLy8gUmVhZCBET01cbiAgICAgIGVuZE9wZXJhdGlvbl9SMihvcHNbaV0pO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgb3BzLmxlbmd0aDsgaSsrKSAvLyBXcml0ZSBET00gKG1heWJlKVxuICAgICAgZW5kT3BlcmF0aW9uX1cyKG9wc1tpXSk7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBvcHMubGVuZ3RoOyBpKyspIC8vIFJlYWQgRE9NXG4gICAgICBlbmRPcGVyYXRpb25fZmluaXNoKG9wc1tpXSk7XG4gIH1cblxuICBmdW5jdGlvbiBlbmRPcGVyYXRpb25fUjEob3ApIHtcbiAgICB2YXIgY20gPSBvcC5jbSwgZGlzcGxheSA9IGNtLmRpc3BsYXk7XG4gICAgaWYgKG9wLnVwZGF0ZU1heExpbmUpIGZpbmRNYXhMaW5lKGNtKTtcblxuICAgIG9wLm11c3RVcGRhdGUgPSBvcC52aWV3Q2hhbmdlZCB8fCBvcC5mb3JjZVVwZGF0ZSB8fCBvcC5zY3JvbGxUb3AgIT0gbnVsbCB8fFxuICAgICAgb3Auc2Nyb2xsVG9Qb3MgJiYgKG9wLnNjcm9sbFRvUG9zLmZyb20ubGluZSA8IGRpc3BsYXkudmlld0Zyb20gfHxcbiAgICAgICAgICAgICAgICAgICAgICAgICBvcC5zY3JvbGxUb1Bvcy50by5saW5lID49IGRpc3BsYXkudmlld1RvKSB8fFxuICAgICAgZGlzcGxheS5tYXhMaW5lQ2hhbmdlZCAmJiBjbS5vcHRpb25zLmxpbmVXcmFwcGluZztcbiAgICBvcC51cGRhdGUgPSBvcC5tdXN0VXBkYXRlICYmXG4gICAgICBuZXcgRGlzcGxheVVwZGF0ZShjbSwgb3AubXVzdFVwZGF0ZSAmJiB7dG9wOiBvcC5zY3JvbGxUb3AsIGVuc3VyZTogb3Auc2Nyb2xsVG9Qb3N9LCBvcC5mb3JjZVVwZGF0ZSk7XG4gIH1cblxuICBmdW5jdGlvbiBlbmRPcGVyYXRpb25fVzEob3ApIHtcbiAgICBvcC51cGRhdGVkRGlzcGxheSA9IG9wLm11c3RVcGRhdGUgJiYgdXBkYXRlRGlzcGxheUlmTmVlZGVkKG9wLmNtLCBvcC51cGRhdGUpO1xuICB9XG5cbiAgZnVuY3Rpb24gZW5kT3BlcmF0aW9uX1IyKG9wKSB7XG4gICAgdmFyIGNtID0gb3AuY20sIGRpc3BsYXkgPSBjbS5kaXNwbGF5O1xuICAgIGlmIChvcC51cGRhdGVkRGlzcGxheSkgdXBkYXRlSGVpZ2h0c0luVmlld3BvcnQoY20pO1xuXG4gICAgLy8gSWYgdGhlIG1heCBsaW5lIGNoYW5nZWQgc2luY2UgaXQgd2FzIGxhc3QgbWVhc3VyZWQsIG1lYXN1cmUgaXQsXG4gICAgLy8gYW5kIGVuc3VyZSB0aGUgZG9jdW1lbnQncyB3aWR0aCBtYXRjaGVzIGl0LlxuICAgIC8vIHVwZGF0ZURpc3BsYXlJZk5lZWRlZCB3aWxsIHVzZSB0aGVzZSBwcm9wZXJ0aWVzIHRvIGRvIHRoZSBhY3R1YWwgcmVzaXppbmdcbiAgICBpZiAoZGlzcGxheS5tYXhMaW5lQ2hhbmdlZCAmJiAhY20ub3B0aW9ucy5saW5lV3JhcHBpbmcpIHtcbiAgICAgIG9wLmFkanVzdFdpZHRoVG8gPSBtZWFzdXJlQ2hhcihjbSwgZGlzcGxheS5tYXhMaW5lLCBkaXNwbGF5Lm1heExpbmUudGV4dC5sZW5ndGgpLmxlZnQ7XG4gICAgICBvcC5tYXhTY3JvbGxMZWZ0ID0gTWF0aC5tYXgoMCwgZGlzcGxheS5zaXplci5vZmZzZXRMZWZ0ICsgb3AuYWRqdXN0V2lkdGhUbyArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2Nyb2xsZXJDdXRPZmYgLSBkaXNwbGF5LnNjcm9sbGVyLmNsaWVudFdpZHRoKTtcbiAgICB9XG5cbiAgICBvcC5iYXJNZWFzdXJlID0gbWVhc3VyZUZvclNjcm9sbGJhcnMoY20pO1xuICAgIGlmIChvcC51cGRhdGVkRGlzcGxheSB8fCBvcC5zZWxlY3Rpb25DaGFuZ2VkKVxuICAgICAgb3AubmV3U2VsZWN0aW9uTm9kZXMgPSBkcmF3U2VsZWN0aW9uKGNtKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGVuZE9wZXJhdGlvbl9XMihvcCkge1xuICAgIHZhciBjbSA9IG9wLmNtO1xuXG4gICAgaWYgKG9wLmFkanVzdFdpZHRoVG8gIT0gbnVsbCkge1xuICAgICAgY20uZGlzcGxheS5zaXplci5zdHlsZS5taW5XaWR0aCA9IG9wLmFkanVzdFdpZHRoVG8gKyBcInB4XCI7XG4gICAgICBpZiAob3AubWF4U2Nyb2xsTGVmdCA8IGNtLmRvYy5zY3JvbGxMZWZ0KVxuICAgICAgICBzZXRTY3JvbGxMZWZ0KGNtLCBNYXRoLm1pbihjbS5kaXNwbGF5LnNjcm9sbGVyLnNjcm9sbExlZnQsIG9wLm1heFNjcm9sbExlZnQpLCB0cnVlKTtcbiAgICB9XG5cbiAgICBpZiAob3AubmV3U2VsZWN0aW9uTm9kZXMpXG4gICAgICB1cGRhdGVTZWxlY3Rpb24oY20sIG9wLm5ld1NlbGVjdGlvbk5vZGVzKTtcbiAgICBpZiAob3AudXBkYXRlZERpc3BsYXkpXG4gICAgICBzZXREb2N1bWVudEhlaWdodChjbSwgb3AuYmFyTWVhc3VyZSk7XG4gICAgaWYgKG9wLnVwZGF0ZWREaXNwbGF5IHx8IG9wLnN0YXJ0SGVpZ2h0ICE9IGNtLmRvYy5oZWlnaHQpXG4gICAgICB1cGRhdGVTY3JvbGxiYXJzKGNtLCBvcC5iYXJNZWFzdXJlKTtcblxuICAgIGlmIChvcC5zZWxlY3Rpb25DaGFuZ2VkKSByZXN0YXJ0QmxpbmsoY20pO1xuXG4gICAgaWYgKGNtLnN0YXRlLmZvY3VzZWQgJiYgb3AudXBkYXRlSW5wdXQpXG4gICAgICByZXNldElucHV0KGNtLCBvcC50eXBpbmcpO1xuICB9XG5cbiAgZnVuY3Rpb24gZW5kT3BlcmF0aW9uX2ZpbmlzaChvcCkge1xuICAgIHZhciBjbSA9IG9wLmNtLCBkaXNwbGF5ID0gY20uZGlzcGxheSwgZG9jID0gY20uZG9jO1xuXG4gICAgaWYgKG9wLnVwZGF0ZWREaXNwbGF5KSBwb3N0VXBkYXRlRGlzcGxheShjbSwgb3AudXBkYXRlKTtcblxuICAgIC8vIEFib3J0IG1vdXNlIHdoZWVsIGRlbHRhIG1lYXN1cmVtZW50LCB3aGVuIHNjcm9sbGluZyBleHBsaWNpdGx5XG4gICAgaWYgKGRpc3BsYXkud2hlZWxTdGFydFggIT0gbnVsbCAmJiAob3Auc2Nyb2xsVG9wICE9IG51bGwgfHwgb3Auc2Nyb2xsTGVmdCAhPSBudWxsIHx8IG9wLnNjcm9sbFRvUG9zKSlcbiAgICAgIGRpc3BsYXkud2hlZWxTdGFydFggPSBkaXNwbGF5LndoZWVsU3RhcnRZID0gbnVsbDtcblxuICAgIC8vIFByb3BhZ2F0ZSB0aGUgc2Nyb2xsIHBvc2l0aW9uIHRvIHRoZSBhY3R1YWwgRE9NIHNjcm9sbGVyXG4gICAgaWYgKG9wLnNjcm9sbFRvcCAhPSBudWxsICYmIGRpc3BsYXkuc2Nyb2xsZXIuc2Nyb2xsVG9wICE9IG9wLnNjcm9sbFRvcCkge1xuICAgICAgdmFyIHRvcCA9IE1hdGgubWF4KDAsIE1hdGgubWluKGRpc3BsYXkuc2Nyb2xsZXIuc2Nyb2xsSGVpZ2h0IC0gZGlzcGxheS5zY3JvbGxlci5jbGllbnRIZWlnaHQsIG9wLnNjcm9sbFRvcCkpO1xuICAgICAgZGlzcGxheS5zY3JvbGxlci5zY3JvbGxUb3AgPSBkaXNwbGF5LnNjcm9sbGJhclYuc2Nyb2xsVG9wID0gZG9jLnNjcm9sbFRvcCA9IHRvcDtcbiAgICB9XG4gICAgaWYgKG9wLnNjcm9sbExlZnQgIT0gbnVsbCAmJiBkaXNwbGF5LnNjcm9sbGVyLnNjcm9sbExlZnQgIT0gb3Auc2Nyb2xsTGVmdCkge1xuICAgICAgdmFyIGxlZnQgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihkaXNwbGF5LnNjcm9sbGVyLnNjcm9sbFdpZHRoIC0gZGlzcGxheS5zY3JvbGxlci5jbGllbnRXaWR0aCwgb3Auc2Nyb2xsTGVmdCkpO1xuICAgICAgZGlzcGxheS5zY3JvbGxlci5zY3JvbGxMZWZ0ID0gZGlzcGxheS5zY3JvbGxiYXJILnNjcm9sbExlZnQgPSBkb2Muc2Nyb2xsTGVmdCA9IGxlZnQ7XG4gICAgICBhbGlnbkhvcml6b250YWxseShjbSk7XG4gICAgfVxuICAgIC8vIElmIHdlIG5lZWQgdG8gc2Nyb2xsIGEgc3BlY2lmaWMgcG9zaXRpb24gaW50byB2aWV3LCBkbyBzby5cbiAgICBpZiAob3Auc2Nyb2xsVG9Qb3MpIHtcbiAgICAgIHZhciBjb29yZHMgPSBzY3JvbGxQb3NJbnRvVmlldyhjbSwgY2xpcFBvcyhkb2MsIG9wLnNjcm9sbFRvUG9zLmZyb20pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsaXBQb3MoZG9jLCBvcC5zY3JvbGxUb1Bvcy50byksIG9wLnNjcm9sbFRvUG9zLm1hcmdpbik7XG4gICAgICBpZiAob3Auc2Nyb2xsVG9Qb3MuaXNDdXJzb3IgJiYgY20uc3RhdGUuZm9jdXNlZCkgbWF5YmVTY3JvbGxXaW5kb3coY20sIGNvb3Jkcyk7XG4gICAgfVxuXG4gICAgLy8gRmlyZSBldmVudHMgZm9yIG1hcmtlcnMgdGhhdCBhcmUgaGlkZGVuL3VuaWRkZW4gYnkgZWRpdGluZyBvclxuICAgIC8vIHVuZG9pbmdcbiAgICB2YXIgaGlkZGVuID0gb3AubWF5YmVIaWRkZW5NYXJrZXJzLCB1bmhpZGRlbiA9IG9wLm1heWJlVW5oaWRkZW5NYXJrZXJzO1xuICAgIGlmIChoaWRkZW4pIGZvciAodmFyIGkgPSAwOyBpIDwgaGlkZGVuLmxlbmd0aDsgKytpKVxuICAgICAgaWYgKCFoaWRkZW5baV0ubGluZXMubGVuZ3RoKSBzaWduYWwoaGlkZGVuW2ldLCBcImhpZGVcIik7XG4gICAgaWYgKHVuaGlkZGVuKSBmb3IgKHZhciBpID0gMDsgaSA8IHVuaGlkZGVuLmxlbmd0aDsgKytpKVxuICAgICAgaWYgKHVuaGlkZGVuW2ldLmxpbmVzLmxlbmd0aCkgc2lnbmFsKHVuaGlkZGVuW2ldLCBcInVuaGlkZVwiKTtcblxuICAgIGlmIChkaXNwbGF5LndyYXBwZXIub2Zmc2V0SGVpZ2h0KVxuICAgICAgZG9jLnNjcm9sbFRvcCA9IGNtLmRpc3BsYXkuc2Nyb2xsZXIuc2Nyb2xsVG9wO1xuXG4gICAgLy8gQXBwbHkgd29ya2Fyb3VuZCBmb3IgdHdvIHdlYmtpdCBidWdzXG4gICAgaWYgKG9wLnVwZGF0ZWREaXNwbGF5ICYmIHdlYmtpdCkge1xuICAgICAgaWYgKGNtLm9wdGlvbnMubGluZVdyYXBwaW5nKVxuICAgICAgICBjaGVja0ZvcldlYmtpdFdpZHRoQnVnKGNtLCBvcC5iYXJNZWFzdXJlKTsgLy8gKElzc3VlICMyNDIwKVxuICAgICAgaWYgKG9wLmJhck1lYXN1cmUuc2Nyb2xsV2lkdGggPiBvcC5iYXJNZWFzdXJlLmNsaWVudFdpZHRoICYmXG4gICAgICAgICAgb3AuYmFyTWVhc3VyZS5zY3JvbGxXaWR0aCA8IG9wLmJhck1lYXN1cmUuY2xpZW50V2lkdGggKyAxICYmXG4gICAgICAgICAgIWhTY3JvbGxiYXJUYWtlc1NwYWNlKGNtKSlcbiAgICAgICAgdXBkYXRlU2Nyb2xsYmFycyhjbSk7IC8vIChJc3N1ZSAjMjU2MilcbiAgICB9XG5cbiAgICAvLyBGaXJlIGNoYW5nZSBldmVudHMsIGFuZCBkZWxheWVkIGV2ZW50IGhhbmRsZXJzXG4gICAgaWYgKG9wLmNoYW5nZU9ianMpXG4gICAgICBzaWduYWwoY20sIFwiY2hhbmdlc1wiLCBjbSwgb3AuY2hhbmdlT2Jqcyk7XG4gIH1cblxuICAvLyBSdW4gdGhlIGdpdmVuIGZ1bmN0aW9uIGluIGFuIG9wZXJhdGlvblxuICBmdW5jdGlvbiBydW5Jbk9wKGNtLCBmKSB7XG4gICAgaWYgKGNtLmN1ck9wKSByZXR1cm4gZigpO1xuICAgIHN0YXJ0T3BlcmF0aW9uKGNtKTtcbiAgICB0cnkgeyByZXR1cm4gZigpOyB9XG4gICAgZmluYWxseSB7IGVuZE9wZXJhdGlvbihjbSk7IH1cbiAgfVxuICAvLyBXcmFwcyBhIGZ1bmN0aW9uIGluIGFuIG9wZXJhdGlvbi4gUmV0dXJucyB0aGUgd3JhcHBlZCBmdW5jdGlvbi5cbiAgZnVuY3Rpb24gb3BlcmF0aW9uKGNtLCBmKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgaWYgKGNtLmN1ck9wKSByZXR1cm4gZi5hcHBseShjbSwgYXJndW1lbnRzKTtcbiAgICAgIHN0YXJ0T3BlcmF0aW9uKGNtKTtcbiAgICAgIHRyeSB7IHJldHVybiBmLmFwcGx5KGNtLCBhcmd1bWVudHMpOyB9XG4gICAgICBmaW5hbGx5IHsgZW5kT3BlcmF0aW9uKGNtKTsgfVxuICAgIH07XG4gIH1cbiAgLy8gVXNlZCB0byBhZGQgbWV0aG9kcyB0byBlZGl0b3IgYW5kIGRvYyBpbnN0YW5jZXMsIHdyYXBwaW5nIHRoZW0gaW5cbiAgLy8gb3BlcmF0aW9ucy5cbiAgZnVuY3Rpb24gbWV0aG9kT3AoZikge1xuICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgIGlmICh0aGlzLmN1ck9wKSByZXR1cm4gZi5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgICAgc3RhcnRPcGVyYXRpb24odGhpcyk7XG4gICAgICB0cnkgeyByZXR1cm4gZi5hcHBseSh0aGlzLCBhcmd1bWVudHMpOyB9XG4gICAgICBmaW5hbGx5IHsgZW5kT3BlcmF0aW9uKHRoaXMpOyB9XG4gICAgfTtcbiAgfVxuICBmdW5jdGlvbiBkb2NNZXRob2RPcChmKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIGNtID0gdGhpcy5jbTtcbiAgICAgIGlmICghY20gfHwgY20uY3VyT3ApIHJldHVybiBmLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgICBzdGFydE9wZXJhdGlvbihjbSk7XG4gICAgICB0cnkgeyByZXR1cm4gZi5hcHBseSh0aGlzLCBhcmd1bWVudHMpOyB9XG4gICAgICBmaW5hbGx5IHsgZW5kT3BlcmF0aW9uKGNtKTsgfVxuICAgIH07XG4gIH1cblxuICAvLyBWSUVXIFRSQUNLSU5HXG5cbiAgLy8gVGhlc2Ugb2JqZWN0cyBhcmUgdXNlZCB0byByZXByZXNlbnQgdGhlIHZpc2libGUgKGN1cnJlbnRseSBkcmF3bilcbiAgLy8gcGFydCBvZiB0aGUgZG9jdW1lbnQuIEEgTGluZVZpZXcgbWF5IGNvcnJlc3BvbmQgdG8gbXVsdGlwbGVcbiAgLy8gbG9naWNhbCBsaW5lcywgaWYgdGhvc2UgYXJlIGNvbm5lY3RlZCBieSBjb2xsYXBzZWQgcmFuZ2VzLlxuICBmdW5jdGlvbiBMaW5lVmlldyhkb2MsIGxpbmUsIGxpbmVOKSB7XG4gICAgLy8gVGhlIHN0YXJ0aW5nIGxpbmVcbiAgICB0aGlzLmxpbmUgPSBsaW5lO1xuICAgIC8vIENvbnRpbnVpbmcgbGluZXMsIGlmIGFueVxuICAgIHRoaXMucmVzdCA9IHZpc3VhbExpbmVDb250aW51ZWQobGluZSk7XG4gICAgLy8gTnVtYmVyIG9mIGxvZ2ljYWwgbGluZXMgaW4gdGhpcyB2aXN1YWwgbGluZVxuICAgIHRoaXMuc2l6ZSA9IHRoaXMucmVzdCA/IGxpbmVObyhsc3QodGhpcy5yZXN0KSkgLSBsaW5lTiArIDEgOiAxO1xuICAgIHRoaXMubm9kZSA9IHRoaXMudGV4dCA9IG51bGw7XG4gICAgdGhpcy5oaWRkZW4gPSBsaW5lSXNIaWRkZW4oZG9jLCBsaW5lKTtcbiAgfVxuXG4gIC8vIENyZWF0ZSBhIHJhbmdlIG9mIExpbmVWaWV3IG9iamVjdHMgZm9yIHRoZSBnaXZlbiBsaW5lcy5cbiAgZnVuY3Rpb24gYnVpbGRWaWV3QXJyYXkoY20sIGZyb20sIHRvKSB7XG4gICAgdmFyIGFycmF5ID0gW10sIG5leHRQb3M7XG4gICAgZm9yICh2YXIgcG9zID0gZnJvbTsgcG9zIDwgdG87IHBvcyA9IG5leHRQb3MpIHtcbiAgICAgIHZhciB2aWV3ID0gbmV3IExpbmVWaWV3KGNtLmRvYywgZ2V0TGluZShjbS5kb2MsIHBvcyksIHBvcyk7XG4gICAgICBuZXh0UG9zID0gcG9zICsgdmlldy5zaXplO1xuICAgICAgYXJyYXkucHVzaCh2aWV3KTtcbiAgICB9XG4gICAgcmV0dXJuIGFycmF5O1xuICB9XG5cbiAgLy8gVXBkYXRlcyB0aGUgZGlzcGxheS52aWV3IGRhdGEgc3RydWN0dXJlIGZvciBhIGdpdmVuIGNoYW5nZSB0byB0aGVcbiAgLy8gZG9jdW1lbnQuIEZyb20gYW5kIHRvIGFyZSBpbiBwcmUtY2hhbmdlIGNvb3JkaW5hdGVzLiBMZW5kaWZmIGlzXG4gIC8vIHRoZSBhbW91bnQgb2YgbGluZXMgYWRkZWQgb3Igc3VidHJhY3RlZCBieSB0aGUgY2hhbmdlLiBUaGlzIGlzXG4gIC8vIHVzZWQgZm9yIGNoYW5nZXMgdGhhdCBzcGFuIG11bHRpcGxlIGxpbmVzLCBvciBjaGFuZ2UgdGhlIHdheVxuICAvLyBsaW5lcyBhcmUgZGl2aWRlZCBpbnRvIHZpc3VhbCBsaW5lcy4gcmVnTGluZUNoYW5nZSAoYmVsb3cpXG4gIC8vIHJlZ2lzdGVycyBzaW5nbGUtbGluZSBjaGFuZ2VzLlxuICBmdW5jdGlvbiByZWdDaGFuZ2UoY20sIGZyb20sIHRvLCBsZW5kaWZmKSB7XG4gICAgaWYgKGZyb20gPT0gbnVsbCkgZnJvbSA9IGNtLmRvYy5maXJzdDtcbiAgICBpZiAodG8gPT0gbnVsbCkgdG8gPSBjbS5kb2MuZmlyc3QgKyBjbS5kb2Muc2l6ZTtcbiAgICBpZiAoIWxlbmRpZmYpIGxlbmRpZmYgPSAwO1xuXG4gICAgdmFyIGRpc3BsYXkgPSBjbS5kaXNwbGF5O1xuICAgIGlmIChsZW5kaWZmICYmIHRvIDwgZGlzcGxheS52aWV3VG8gJiZcbiAgICAgICAgKGRpc3BsYXkudXBkYXRlTGluZU51bWJlcnMgPT0gbnVsbCB8fCBkaXNwbGF5LnVwZGF0ZUxpbmVOdW1iZXJzID4gZnJvbSkpXG4gICAgICBkaXNwbGF5LnVwZGF0ZUxpbmVOdW1iZXJzID0gZnJvbTtcblxuICAgIGNtLmN1ck9wLnZpZXdDaGFuZ2VkID0gdHJ1ZTtcblxuICAgIGlmIChmcm9tID49IGRpc3BsYXkudmlld1RvKSB7IC8vIENoYW5nZSBhZnRlclxuICAgICAgaWYgKHNhd0NvbGxhcHNlZFNwYW5zICYmIHZpc3VhbExpbmVObyhjbS5kb2MsIGZyb20pIDwgZGlzcGxheS52aWV3VG8pXG4gICAgICAgIHJlc2V0VmlldyhjbSk7XG4gICAgfSBlbHNlIGlmICh0byA8PSBkaXNwbGF5LnZpZXdGcm9tKSB7IC8vIENoYW5nZSBiZWZvcmVcbiAgICAgIGlmIChzYXdDb2xsYXBzZWRTcGFucyAmJiB2aXN1YWxMaW5lRW5kTm8oY20uZG9jLCB0byArIGxlbmRpZmYpID4gZGlzcGxheS52aWV3RnJvbSkge1xuICAgICAgICByZXNldFZpZXcoY20pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZGlzcGxheS52aWV3RnJvbSArPSBsZW5kaWZmO1xuICAgICAgICBkaXNwbGF5LnZpZXdUbyArPSBsZW5kaWZmO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoZnJvbSA8PSBkaXNwbGF5LnZpZXdGcm9tICYmIHRvID49IGRpc3BsYXkudmlld1RvKSB7IC8vIEZ1bGwgb3ZlcmxhcFxuICAgICAgcmVzZXRWaWV3KGNtKTtcbiAgICB9IGVsc2UgaWYgKGZyb20gPD0gZGlzcGxheS52aWV3RnJvbSkgeyAvLyBUb3Agb3ZlcmxhcFxuICAgICAgdmFyIGN1dCA9IHZpZXdDdXR0aW5nUG9pbnQoY20sIHRvLCB0byArIGxlbmRpZmYsIDEpO1xuICAgICAgaWYgKGN1dCkge1xuICAgICAgICBkaXNwbGF5LnZpZXcgPSBkaXNwbGF5LnZpZXcuc2xpY2UoY3V0LmluZGV4KTtcbiAgICAgICAgZGlzcGxheS52aWV3RnJvbSA9IGN1dC5saW5lTjtcbiAgICAgICAgZGlzcGxheS52aWV3VG8gKz0gbGVuZGlmZjtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlc2V0VmlldyhjbSk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmICh0byA+PSBkaXNwbGF5LnZpZXdUbykgeyAvLyBCb3R0b20gb3ZlcmxhcFxuICAgICAgdmFyIGN1dCA9IHZpZXdDdXR0aW5nUG9pbnQoY20sIGZyb20sIGZyb20sIC0xKTtcbiAgICAgIGlmIChjdXQpIHtcbiAgICAgICAgZGlzcGxheS52aWV3ID0gZGlzcGxheS52aWV3LnNsaWNlKDAsIGN1dC5pbmRleCk7XG4gICAgICAgIGRpc3BsYXkudmlld1RvID0gY3V0LmxpbmVOO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmVzZXRWaWV3KGNtKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgeyAvLyBHYXAgaW4gdGhlIG1pZGRsZVxuICAgICAgdmFyIGN1dFRvcCA9IHZpZXdDdXR0aW5nUG9pbnQoY20sIGZyb20sIGZyb20sIC0xKTtcbiAgICAgIHZhciBjdXRCb3QgPSB2aWV3Q3V0dGluZ1BvaW50KGNtLCB0bywgdG8gKyBsZW5kaWZmLCAxKTtcbiAgICAgIGlmIChjdXRUb3AgJiYgY3V0Qm90KSB7XG4gICAgICAgIGRpc3BsYXkudmlldyA9IGRpc3BsYXkudmlldy5zbGljZSgwLCBjdXRUb3AuaW5kZXgpXG4gICAgICAgICAgLmNvbmNhdChidWlsZFZpZXdBcnJheShjbSwgY3V0VG9wLmxpbmVOLCBjdXRCb3QubGluZU4pKVxuICAgICAgICAgIC5jb25jYXQoZGlzcGxheS52aWV3LnNsaWNlKGN1dEJvdC5pbmRleCkpO1xuICAgICAgICBkaXNwbGF5LnZpZXdUbyArPSBsZW5kaWZmO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmVzZXRWaWV3KGNtKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB2YXIgZXh0ID0gZGlzcGxheS5leHRlcm5hbE1lYXN1cmVkO1xuICAgIGlmIChleHQpIHtcbiAgICAgIGlmICh0byA8IGV4dC5saW5lTilcbiAgICAgICAgZXh0LmxpbmVOICs9IGxlbmRpZmY7XG4gICAgICBlbHNlIGlmIChmcm9tIDwgZXh0LmxpbmVOICsgZXh0LnNpemUpXG4gICAgICAgIGRpc3BsYXkuZXh0ZXJuYWxNZWFzdXJlZCA9IG51bGw7XG4gICAgfVxuICB9XG5cbiAgLy8gUmVnaXN0ZXIgYSBjaGFuZ2UgdG8gYSBzaW5nbGUgbGluZS4gVHlwZSBtdXN0IGJlIG9uZSBvZiBcInRleHRcIixcbiAgLy8gXCJndXR0ZXJcIiwgXCJjbGFzc1wiLCBcIndpZGdldFwiXG4gIGZ1bmN0aW9uIHJlZ0xpbmVDaGFuZ2UoY20sIGxpbmUsIHR5cGUpIHtcbiAgICBjbS5jdXJPcC52aWV3Q2hhbmdlZCA9IHRydWU7XG4gICAgdmFyIGRpc3BsYXkgPSBjbS5kaXNwbGF5LCBleHQgPSBjbS5kaXNwbGF5LmV4dGVybmFsTWVhc3VyZWQ7XG4gICAgaWYgKGV4dCAmJiBsaW5lID49IGV4dC5saW5lTiAmJiBsaW5lIDwgZXh0LmxpbmVOICsgZXh0LnNpemUpXG4gICAgICBkaXNwbGF5LmV4dGVybmFsTWVhc3VyZWQgPSBudWxsO1xuXG4gICAgaWYgKGxpbmUgPCBkaXNwbGF5LnZpZXdGcm9tIHx8IGxpbmUgPj0gZGlzcGxheS52aWV3VG8pIHJldHVybjtcbiAgICB2YXIgbGluZVZpZXcgPSBkaXNwbGF5LnZpZXdbZmluZFZpZXdJbmRleChjbSwgbGluZSldO1xuICAgIGlmIChsaW5lVmlldy5ub2RlID09IG51bGwpIHJldHVybjtcbiAgICB2YXIgYXJyID0gbGluZVZpZXcuY2hhbmdlcyB8fCAobGluZVZpZXcuY2hhbmdlcyA9IFtdKTtcbiAgICBpZiAoaW5kZXhPZihhcnIsIHR5cGUpID09IC0xKSBhcnIucHVzaCh0eXBlKTtcbiAgfVxuXG4gIC8vIENsZWFyIHRoZSB2aWV3LlxuICBmdW5jdGlvbiByZXNldFZpZXcoY20pIHtcbiAgICBjbS5kaXNwbGF5LnZpZXdGcm9tID0gY20uZGlzcGxheS52aWV3VG8gPSBjbS5kb2MuZmlyc3Q7XG4gICAgY20uZGlzcGxheS52aWV3ID0gW107XG4gICAgY20uZGlzcGxheS52aWV3T2Zmc2V0ID0gMDtcbiAgfVxuXG4gIC8vIEZpbmQgdGhlIHZpZXcgZWxlbWVudCBjb3JyZXNwb25kaW5nIHRvIGEgZ2l2ZW4gbGluZS4gUmV0dXJuIG51bGxcbiAgLy8gd2hlbiB0aGUgbGluZSBpc24ndCB2aXNpYmxlLlxuICBmdW5jdGlvbiBmaW5kVmlld0luZGV4KGNtLCBuKSB7XG4gICAgaWYgKG4gPj0gY20uZGlzcGxheS52aWV3VG8pIHJldHVybiBudWxsO1xuICAgIG4gLT0gY20uZGlzcGxheS52aWV3RnJvbTtcbiAgICBpZiAobiA8IDApIHJldHVybiBudWxsO1xuICAgIHZhciB2aWV3ID0gY20uZGlzcGxheS52aWV3O1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdmlldy5sZW5ndGg7IGkrKykge1xuICAgICAgbiAtPSB2aWV3W2ldLnNpemU7XG4gICAgICBpZiAobiA8IDApIHJldHVybiBpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHZpZXdDdXR0aW5nUG9pbnQoY20sIG9sZE4sIG5ld04sIGRpcikge1xuICAgIHZhciBpbmRleCA9IGZpbmRWaWV3SW5kZXgoY20sIG9sZE4pLCBkaWZmLCB2aWV3ID0gY20uZGlzcGxheS52aWV3O1xuICAgIGlmICghc2F3Q29sbGFwc2VkU3BhbnMgfHwgbmV3TiA9PSBjbS5kb2MuZmlyc3QgKyBjbS5kb2Muc2l6ZSlcbiAgICAgIHJldHVybiB7aW5kZXg6IGluZGV4LCBsaW5lTjogbmV3Tn07XG4gICAgZm9yICh2YXIgaSA9IDAsIG4gPSBjbS5kaXNwbGF5LnZpZXdGcm9tOyBpIDwgaW5kZXg7IGkrKylcbiAgICAgIG4gKz0gdmlld1tpXS5zaXplO1xuICAgIGlmIChuICE9IG9sZE4pIHtcbiAgICAgIGlmIChkaXIgPiAwKSB7XG4gICAgICAgIGlmIChpbmRleCA9PSB2aWV3Lmxlbmd0aCAtIDEpIHJldHVybiBudWxsO1xuICAgICAgICBkaWZmID0gKG4gKyB2aWV3W2luZGV4XS5zaXplKSAtIG9sZE47XG4gICAgICAgIGluZGV4Kys7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBkaWZmID0gbiAtIG9sZE47XG4gICAgICB9XG4gICAgICBvbGROICs9IGRpZmY7IG5ld04gKz0gZGlmZjtcbiAgICB9XG4gICAgd2hpbGUgKHZpc3VhbExpbmVObyhjbS5kb2MsIG5ld04pICE9IG5ld04pIHtcbiAgICAgIGlmIChpbmRleCA9PSAoZGlyIDwgMCA/IDAgOiB2aWV3Lmxlbmd0aCAtIDEpKSByZXR1cm4gbnVsbDtcbiAgICAgIG5ld04gKz0gZGlyICogdmlld1tpbmRleCAtIChkaXIgPCAwID8gMSA6IDApXS5zaXplO1xuICAgICAgaW5kZXggKz0gZGlyO1xuICAgIH1cbiAgICByZXR1cm4ge2luZGV4OiBpbmRleCwgbGluZU46IG5ld059O1xuICB9XG5cbiAgLy8gRm9yY2UgdGhlIHZpZXcgdG8gY292ZXIgYSBnaXZlbiByYW5nZSwgYWRkaW5nIGVtcHR5IHZpZXcgZWxlbWVudFxuICAvLyBvciBjbGlwcGluZyBvZmYgZXhpc3Rpbmcgb25lcyBhcyBuZWVkZWQuXG4gIGZ1bmN0aW9uIGFkanVzdFZpZXcoY20sIGZyb20sIHRvKSB7XG4gICAgdmFyIGRpc3BsYXkgPSBjbS5kaXNwbGF5LCB2aWV3ID0gZGlzcGxheS52aWV3O1xuICAgIGlmICh2aWV3Lmxlbmd0aCA9PSAwIHx8IGZyb20gPj0gZGlzcGxheS52aWV3VG8gfHwgdG8gPD0gZGlzcGxheS52aWV3RnJvbSkge1xuICAgICAgZGlzcGxheS52aWV3ID0gYnVpbGRWaWV3QXJyYXkoY20sIGZyb20sIHRvKTtcbiAgICAgIGRpc3BsYXkudmlld0Zyb20gPSBmcm9tO1xuICAgIH0gZWxzZSB7XG4gICAgICBpZiAoZGlzcGxheS52aWV3RnJvbSA+IGZyb20pXG4gICAgICAgIGRpc3BsYXkudmlldyA9IGJ1aWxkVmlld0FycmF5KGNtLCBmcm9tLCBkaXNwbGF5LnZpZXdGcm9tKS5jb25jYXQoZGlzcGxheS52aWV3KTtcbiAgICAgIGVsc2UgaWYgKGRpc3BsYXkudmlld0Zyb20gPCBmcm9tKVxuICAgICAgICBkaXNwbGF5LnZpZXcgPSBkaXNwbGF5LnZpZXcuc2xpY2UoZmluZFZpZXdJbmRleChjbSwgZnJvbSkpO1xuICAgICAgZGlzcGxheS52aWV3RnJvbSA9IGZyb207XG4gICAgICBpZiAoZGlzcGxheS52aWV3VG8gPCB0bylcbiAgICAgICAgZGlzcGxheS52aWV3ID0gZGlzcGxheS52aWV3LmNvbmNhdChidWlsZFZpZXdBcnJheShjbSwgZGlzcGxheS52aWV3VG8sIHRvKSk7XG4gICAgICBlbHNlIGlmIChkaXNwbGF5LnZpZXdUbyA+IHRvKVxuICAgICAgICBkaXNwbGF5LnZpZXcgPSBkaXNwbGF5LnZpZXcuc2xpY2UoMCwgZmluZFZpZXdJbmRleChjbSwgdG8pKTtcbiAgICB9XG4gICAgZGlzcGxheS52aWV3VG8gPSB0bztcbiAgfVxuXG4gIC8vIENvdW50IHRoZSBudW1iZXIgb2YgbGluZXMgaW4gdGhlIHZpZXcgd2hvc2UgRE9NIHJlcHJlc2VudGF0aW9uIGlzXG4gIC8vIG91dCBvZiBkYXRlIChvciBub25leGlzdGVudCkuXG4gIGZ1bmN0aW9uIGNvdW50RGlydHlWaWV3KGNtKSB7XG4gICAgdmFyIHZpZXcgPSBjbS5kaXNwbGF5LnZpZXcsIGRpcnR5ID0gMDtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHZpZXcubGVuZ3RoOyBpKyspIHtcbiAgICAgIHZhciBsaW5lVmlldyA9IHZpZXdbaV07XG4gICAgICBpZiAoIWxpbmVWaWV3LmhpZGRlbiAmJiAoIWxpbmVWaWV3Lm5vZGUgfHwgbGluZVZpZXcuY2hhbmdlcykpICsrZGlydHk7XG4gICAgfVxuICAgIHJldHVybiBkaXJ0eTtcbiAgfVxuXG4gIC8vIElOUFVUIEhBTkRMSU5HXG5cbiAgLy8gUG9sbCBmb3IgaW5wdXQgY2hhbmdlcywgdXNpbmcgdGhlIG5vcm1hbCByYXRlIG9mIHBvbGxpbmcuIFRoaXNcbiAgLy8gcnVucyBhcyBsb25nIGFzIHRoZSBlZGl0b3IgaXMgZm9jdXNlZC5cbiAgZnVuY3Rpb24gc2xvd1BvbGwoY20pIHtcbiAgICBpZiAoY20uZGlzcGxheS5wb2xsaW5nRmFzdCkgcmV0dXJuO1xuICAgIGNtLmRpc3BsYXkucG9sbC5zZXQoY20ub3B0aW9ucy5wb2xsSW50ZXJ2YWwsIGZ1bmN0aW9uKCkge1xuICAgICAgcmVhZElucHV0KGNtKTtcbiAgICAgIGlmIChjbS5zdGF0ZS5mb2N1c2VkKSBzbG93UG9sbChjbSk7XG4gICAgfSk7XG4gIH1cblxuICAvLyBXaGVuIGFuIGV2ZW50IGhhcyBqdXN0IGNvbWUgaW4gdGhhdCBpcyBsaWtlbHkgdG8gYWRkIG9yIGNoYW5nZVxuICAvLyBzb21ldGhpbmcgaW4gdGhlIGlucHV0IHRleHRhcmVhLCB3ZSBwb2xsIGZhc3RlciwgdG8gZW5zdXJlIHRoYXRcbiAgLy8gdGhlIGNoYW5nZSBhcHBlYXJzIG9uIHRoZSBzY3JlZW4gcXVpY2tseS5cbiAgZnVuY3Rpb24gZmFzdFBvbGwoY20pIHtcbiAgICB2YXIgbWlzc2VkID0gZmFsc2U7XG4gICAgY20uZGlzcGxheS5wb2xsaW5nRmFzdCA9IHRydWU7XG4gICAgZnVuY3Rpb24gcCgpIHtcbiAgICAgIHZhciBjaGFuZ2VkID0gcmVhZElucHV0KGNtKTtcbiAgICAgIGlmICghY2hhbmdlZCAmJiAhbWlzc2VkKSB7bWlzc2VkID0gdHJ1ZTsgY20uZGlzcGxheS5wb2xsLnNldCg2MCwgcCk7fVxuICAgICAgZWxzZSB7Y20uZGlzcGxheS5wb2xsaW5nRmFzdCA9IGZhbHNlOyBzbG93UG9sbChjbSk7fVxuICAgIH1cbiAgICBjbS5kaXNwbGF5LnBvbGwuc2V0KDIwLCBwKTtcbiAgfVxuXG4gIC8vIFRoaXMgd2lsbCBiZSBzZXQgdG8gYW4gYXJyYXkgb2Ygc3RyaW5ncyB3aGVuIGNvcHlpbmcsIHNvIHRoYXQsXG4gIC8vIHdoZW4gcGFzdGluZywgd2Uga25vdyB3aGF0IGtpbmQgb2Ygc2VsZWN0aW9ucyB0aGUgY29waWVkIHRleHRcbiAgLy8gd2FzIG1hZGUgb3V0IG9mLlxuICB2YXIgbGFzdENvcGllZCA9IG51bGw7XG5cbiAgLy8gUmVhZCBpbnB1dCBmcm9tIHRoZSB0ZXh0YXJlYSwgYW5kIHVwZGF0ZSB0aGUgZG9jdW1lbnQgdG8gbWF0Y2guXG4gIC8vIFdoZW4gc29tZXRoaW5nIGlzIHNlbGVjdGVkLCBpdCBpcyBwcmVzZW50IGluIHRoZSB0ZXh0YXJlYSwgYW5kXG4gIC8vIHNlbGVjdGVkICh1bmxlc3MgaXQgaXMgaHVnZSwgaW4gd2hpY2ggY2FzZSBhIHBsYWNlaG9sZGVyIGlzXG4gIC8vIHVzZWQpLiBXaGVuIG5vdGhpbmcgaXMgc2VsZWN0ZWQsIHRoZSBjdXJzb3Igc2l0cyBhZnRlciBwcmV2aW91c2x5XG4gIC8vIHNlZW4gdGV4dCAoY2FuIGJlIGVtcHR5KSwgd2hpY2ggaXMgc3RvcmVkIGluIHByZXZJbnB1dCAod2UgbXVzdFxuICAvLyBub3QgcmVzZXQgdGhlIHRleHRhcmVhIHdoZW4gdHlwaW5nLCBiZWNhdXNlIHRoYXQgYnJlYWtzIElNRSkuXG4gIGZ1bmN0aW9uIHJlYWRJbnB1dChjbSkge1xuICAgIHZhciBpbnB1dCA9IGNtLmRpc3BsYXkuaW5wdXQsIHByZXZJbnB1dCA9IGNtLmRpc3BsYXkucHJldklucHV0LCBkb2MgPSBjbS5kb2M7XG4gICAgLy8gU2luY2UgdGhpcyBpcyBjYWxsZWQgYSAqbG90KiwgdHJ5IHRvIGJhaWwgb3V0IGFzIGNoZWFwbHkgYXNcbiAgICAvLyBwb3NzaWJsZSB3aGVuIGl0IGlzIGNsZWFyIHRoYXQgbm90aGluZyBoYXBwZW5lZC4gaGFzU2VsZWN0aW9uXG4gICAgLy8gd2lsbCBiZSB0aGUgY2FzZSB3aGVuIHRoZXJlIGlzIGEgbG90IG9mIHRleHQgaW4gdGhlIHRleHRhcmVhLFxuICAgIC8vIGluIHdoaWNoIGNhc2UgcmVhZGluZyBpdHMgdmFsdWUgd291bGQgYmUgZXhwZW5zaXZlLlxuICAgIGlmICghY20uc3RhdGUuZm9jdXNlZCB8fCAoaGFzU2VsZWN0aW9uKGlucHV0KSAmJiAhcHJldklucHV0KSB8fCBpc1JlYWRPbmx5KGNtKSB8fCBjbS5vcHRpb25zLmRpc2FibGVJbnB1dClcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICAvLyBTZWUgcGFzdGUgaGFuZGxlciBmb3IgbW9yZSBvbiB0aGUgZmFrZWRMYXN0Q2hhciBrbHVkZ2VcbiAgICBpZiAoY20uc3RhdGUucGFzdGVJbmNvbWluZyAmJiBjbS5zdGF0ZS5mYWtlZExhc3RDaGFyKSB7XG4gICAgICBpbnB1dC52YWx1ZSA9IGlucHV0LnZhbHVlLnN1YnN0cmluZygwLCBpbnB1dC52YWx1ZS5sZW5ndGggLSAxKTtcbiAgICAgIGNtLnN0YXRlLmZha2VkTGFzdENoYXIgPSBmYWxzZTtcbiAgICB9XG4gICAgdmFyIHRleHQgPSBpbnB1dC52YWx1ZTtcbiAgICAvLyBJZiBub3RoaW5nIGNoYW5nZWQsIGJhaWwuXG4gICAgaWYgKHRleHQgPT0gcHJldklucHV0ICYmICFjbS5zb21ldGhpbmdTZWxlY3RlZCgpKSByZXR1cm4gZmFsc2U7XG4gICAgLy8gV29yayBhcm91bmQgbm9uc2Vuc2ljYWwgc2VsZWN0aW9uIHJlc2V0dGluZyBpbiBJRTkvMTAsIGFuZFxuICAgIC8vIGluZXhwbGljYWJsZSBhcHBlYXJhbmNlIG9mIHByaXZhdGUgYXJlYSB1bmljb2RlIGNoYXJhY3RlcnMgb25cbiAgICAvLyBzb21lIGtleSBjb21ib3MgaW4gTWFjICgjMjY4OSkuXG4gICAgaWYgKGllICYmIGllX3ZlcnNpb24gPj0gOSAmJiBjbS5kaXNwbGF5LmlucHV0SGFzU2VsZWN0aW9uID09PSB0ZXh0IHx8XG4gICAgICAgIG1hYyAmJiAvW1xcdWY3MDAtXFx1ZjdmZl0vLnRlc3QodGV4dCkpIHtcbiAgICAgIHJlc2V0SW5wdXQoY20pO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHZhciB3aXRoT3AgPSAhY20uY3VyT3A7XG4gICAgaWYgKHdpdGhPcCkgc3RhcnRPcGVyYXRpb24oY20pO1xuICAgIGNtLmRpc3BsYXkuc2hpZnQgPSBmYWxzZTtcblxuICAgIGlmICh0ZXh0LmNoYXJDb2RlQXQoMCkgPT0gMHgyMDBiICYmIGRvYy5zZWwgPT0gY20uZGlzcGxheS5zZWxGb3JDb250ZXh0TWVudSAmJiAhcHJldklucHV0KVxuICAgICAgcHJldklucHV0ID0gXCJcXHUyMDBiXCI7XG4gICAgLy8gRmluZCB0aGUgcGFydCBvZiB0aGUgaW5wdXQgdGhhdCBpcyBhY3R1YWxseSBuZXdcbiAgICB2YXIgc2FtZSA9IDAsIGwgPSBNYXRoLm1pbihwcmV2SW5wdXQubGVuZ3RoLCB0ZXh0Lmxlbmd0aCk7XG4gICAgd2hpbGUgKHNhbWUgPCBsICYmIHByZXZJbnB1dC5jaGFyQ29kZUF0KHNhbWUpID09IHRleHQuY2hhckNvZGVBdChzYW1lKSkgKytzYW1lO1xuICAgIHZhciBpbnNlcnRlZCA9IHRleHQuc2xpY2Uoc2FtZSksIHRleHRMaW5lcyA9IHNwbGl0TGluZXMoaW5zZXJ0ZWQpO1xuXG4gICAgLy8gV2hlbiBwYXNpbmcgTiBsaW5lcyBpbnRvIE4gc2VsZWN0aW9ucywgaW5zZXJ0IG9uZSBsaW5lIHBlciBzZWxlY3Rpb25cbiAgICB2YXIgbXVsdGlQYXN0ZSA9IG51bGw7XG4gICAgaWYgKGNtLnN0YXRlLnBhc3RlSW5jb21pbmcgJiYgZG9jLnNlbC5yYW5nZXMubGVuZ3RoID4gMSkge1xuICAgICAgaWYgKGxhc3RDb3BpZWQgJiYgbGFzdENvcGllZC5qb2luKFwiXFxuXCIpID09IGluc2VydGVkKVxuICAgICAgICBtdWx0aVBhc3RlID0gZG9jLnNlbC5yYW5nZXMubGVuZ3RoICUgbGFzdENvcGllZC5sZW5ndGggPT0gMCAmJiBtYXAobGFzdENvcGllZCwgc3BsaXRMaW5lcyk7XG4gICAgICBlbHNlIGlmICh0ZXh0TGluZXMubGVuZ3RoID09IGRvYy5zZWwucmFuZ2VzLmxlbmd0aClcbiAgICAgICAgbXVsdGlQYXN0ZSA9IG1hcCh0ZXh0TGluZXMsIGZ1bmN0aW9uKGwpIHsgcmV0dXJuIFtsXTsgfSk7XG4gICAgfVxuXG4gICAgLy8gTm9ybWFsIGJlaGF2aW9yIGlzIHRvIGluc2VydCB0aGUgbmV3IHRleHQgaW50byBldmVyeSBzZWxlY3Rpb25cbiAgICBmb3IgKHZhciBpID0gZG9jLnNlbC5yYW5nZXMubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICAgIHZhciByYW5nZSA9IGRvYy5zZWwucmFuZ2VzW2ldO1xuICAgICAgdmFyIGZyb20gPSByYW5nZS5mcm9tKCksIHRvID0gcmFuZ2UudG8oKTtcbiAgICAgIC8vIEhhbmRsZSBkZWxldGlvblxuICAgICAgaWYgKHNhbWUgPCBwcmV2SW5wdXQubGVuZ3RoKVxuICAgICAgICBmcm9tID0gUG9zKGZyb20ubGluZSwgZnJvbS5jaCAtIChwcmV2SW5wdXQubGVuZ3RoIC0gc2FtZSkpO1xuICAgICAgLy8gSGFuZGxlIG92ZXJ3cml0ZVxuICAgICAgZWxzZSBpZiAoY20uc3RhdGUub3ZlcndyaXRlICYmIHJhbmdlLmVtcHR5KCkgJiYgIWNtLnN0YXRlLnBhc3RlSW5jb21pbmcpXG4gICAgICAgIHRvID0gUG9zKHRvLmxpbmUsIE1hdGgubWluKGdldExpbmUoZG9jLCB0by5saW5lKS50ZXh0Lmxlbmd0aCwgdG8uY2ggKyBsc3QodGV4dExpbmVzKS5sZW5ndGgpKTtcbiAgICAgIHZhciB1cGRhdGVJbnB1dCA9IGNtLmN1ck9wLnVwZGF0ZUlucHV0O1xuICAgICAgdmFyIGNoYW5nZUV2ZW50ID0ge2Zyb206IGZyb20sIHRvOiB0bywgdGV4dDogbXVsdGlQYXN0ZSA/IG11bHRpUGFzdGVbaSAlIG11bHRpUGFzdGUubGVuZ3RoXSA6IHRleHRMaW5lcyxcbiAgICAgICAgICAgICAgICAgICAgICAgICBvcmlnaW46IGNtLnN0YXRlLnBhc3RlSW5jb21pbmcgPyBcInBhc3RlXCIgOiBjbS5zdGF0ZS5jdXRJbmNvbWluZyA/IFwiY3V0XCIgOiBcIitpbnB1dFwifTtcbiAgICAgIG1ha2VDaGFuZ2UoY20uZG9jLCBjaGFuZ2VFdmVudCk7XG4gICAgICBzaWduYWxMYXRlcihjbSwgXCJpbnB1dFJlYWRcIiwgY20sIGNoYW5nZUV2ZW50KTtcbiAgICAgIC8vIFdoZW4gYW4gJ2VsZWN0cmljJyBjaGFyYWN0ZXIgaXMgaW5zZXJ0ZWQsIGltbWVkaWF0ZWx5IHRyaWdnZXIgYSByZWluZGVudFxuICAgICAgaWYgKGluc2VydGVkICYmICFjbS5zdGF0ZS5wYXN0ZUluY29taW5nICYmIGNtLm9wdGlvbnMuZWxlY3RyaWNDaGFycyAmJlxuICAgICAgICAgIGNtLm9wdGlvbnMuc21hcnRJbmRlbnQgJiYgcmFuZ2UuaGVhZC5jaCA8IDEwMCAmJlxuICAgICAgICAgICghaSB8fCBkb2Muc2VsLnJhbmdlc1tpIC0gMV0uaGVhZC5saW5lICE9IHJhbmdlLmhlYWQubGluZSkpIHtcbiAgICAgICAgdmFyIG1vZGUgPSBjbS5nZXRNb2RlQXQocmFuZ2UuaGVhZCk7XG4gICAgICAgIGlmIChtb2RlLmVsZWN0cmljQ2hhcnMpIHtcbiAgICAgICAgICBmb3IgKHZhciBqID0gMDsgaiA8IG1vZGUuZWxlY3RyaWNDaGFycy5sZW5ndGg7IGorKylcbiAgICAgICAgICAgIGlmIChpbnNlcnRlZC5pbmRleE9mKG1vZGUuZWxlY3RyaWNDaGFycy5jaGFyQXQoaikpID4gLTEpIHtcbiAgICAgICAgICAgICAgaW5kZW50TGluZShjbSwgcmFuZ2UuaGVhZC5saW5lLCBcInNtYXJ0XCIpO1xuICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChtb2RlLmVsZWN0cmljSW5wdXQpIHtcbiAgICAgICAgICB2YXIgZW5kID0gY2hhbmdlRW5kKGNoYW5nZUV2ZW50KTtcbiAgICAgICAgICBpZiAobW9kZS5lbGVjdHJpY0lucHV0LnRlc3QoZ2V0TGluZShkb2MsIGVuZC5saW5lKS50ZXh0LnNsaWNlKDAsIGVuZC5jaCkpKVxuICAgICAgICAgICAgaW5kZW50TGluZShjbSwgcmFuZ2UuaGVhZC5saW5lLCBcInNtYXJ0XCIpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGVuc3VyZUN1cnNvclZpc2libGUoY20pO1xuICAgIGNtLmN1ck9wLnVwZGF0ZUlucHV0ID0gdXBkYXRlSW5wdXQ7XG4gICAgY20uY3VyT3AudHlwaW5nID0gdHJ1ZTtcblxuICAgIC8vIERvbid0IGxlYXZlIGxvbmcgdGV4dCBpbiB0aGUgdGV4dGFyZWEsIHNpbmNlIGl0IG1ha2VzIGZ1cnRoZXIgcG9sbGluZyBzbG93XG4gICAgaWYgKHRleHQubGVuZ3RoID4gMTAwMCB8fCB0ZXh0LmluZGV4T2YoXCJcXG5cIikgPiAtMSkgaW5wdXQudmFsdWUgPSBjbS5kaXNwbGF5LnByZXZJbnB1dCA9IFwiXCI7XG4gICAgZWxzZSBjbS5kaXNwbGF5LnByZXZJbnB1dCA9IHRleHQ7XG4gICAgaWYgKHdpdGhPcCkgZW5kT3BlcmF0aW9uKGNtKTtcbiAgICBjbS5zdGF0ZS5wYXN0ZUluY29taW5nID0gY20uc3RhdGUuY3V0SW5jb21pbmcgPSBmYWxzZTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIC8vIFJlc2V0IHRoZSBpbnB1dCB0byBjb3JyZXNwb25kIHRvIHRoZSBzZWxlY3Rpb24gKG9yIHRvIGJlIGVtcHR5LFxuICAvLyB3aGVuIG5vdCB0eXBpbmcgYW5kIG5vdGhpbmcgaXMgc2VsZWN0ZWQpXG4gIGZ1bmN0aW9uIHJlc2V0SW5wdXQoY20sIHR5cGluZykge1xuICAgIHZhciBtaW5pbWFsLCBzZWxlY3RlZCwgZG9jID0gY20uZG9jO1xuICAgIGlmIChjbS5zb21ldGhpbmdTZWxlY3RlZCgpKSB7XG4gICAgICBjbS5kaXNwbGF5LnByZXZJbnB1dCA9IFwiXCI7XG4gICAgICB2YXIgcmFuZ2UgPSBkb2Muc2VsLnByaW1hcnkoKTtcbiAgICAgIG1pbmltYWwgPSBoYXNDb3B5RXZlbnQgJiZcbiAgICAgICAgKHJhbmdlLnRvKCkubGluZSAtIHJhbmdlLmZyb20oKS5saW5lID4gMTAwIHx8IChzZWxlY3RlZCA9IGNtLmdldFNlbGVjdGlvbigpKS5sZW5ndGggPiAxMDAwKTtcbiAgICAgIHZhciBjb250ZW50ID0gbWluaW1hbCA/IFwiLVwiIDogc2VsZWN0ZWQgfHwgY20uZ2V0U2VsZWN0aW9uKCk7XG4gICAgICBjbS5kaXNwbGF5LmlucHV0LnZhbHVlID0gY29udGVudDtcbiAgICAgIGlmIChjbS5zdGF0ZS5mb2N1c2VkKSBzZWxlY3RJbnB1dChjbS5kaXNwbGF5LmlucHV0KTtcbiAgICAgIGlmIChpZSAmJiBpZV92ZXJzaW9uID49IDkpIGNtLmRpc3BsYXkuaW5wdXRIYXNTZWxlY3Rpb24gPSBjb250ZW50O1xuICAgIH0gZWxzZSBpZiAoIXR5cGluZykge1xuICAgICAgY20uZGlzcGxheS5wcmV2SW5wdXQgPSBjbS5kaXNwbGF5LmlucHV0LnZhbHVlID0gXCJcIjtcbiAgICAgIGlmIChpZSAmJiBpZV92ZXJzaW9uID49IDkpIGNtLmRpc3BsYXkuaW5wdXRIYXNTZWxlY3Rpb24gPSBudWxsO1xuICAgIH1cbiAgICBjbS5kaXNwbGF5LmluYWNjdXJhdGVTZWxlY3Rpb24gPSBtaW5pbWFsO1xuICB9XG5cbiAgZnVuY3Rpb24gZm9jdXNJbnB1dChjbSkge1xuICAgIGlmIChjbS5vcHRpb25zLnJlYWRPbmx5ICE9IFwibm9jdXJzb3JcIiAmJiAoIW1vYmlsZSB8fCBhY3RpdmVFbHQoKSAhPSBjbS5kaXNwbGF5LmlucHV0KSlcbiAgICAgIGNtLmRpc3BsYXkuaW5wdXQuZm9jdXMoKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGVuc3VyZUZvY3VzKGNtKSB7XG4gICAgaWYgKCFjbS5zdGF0ZS5mb2N1c2VkKSB7IGZvY3VzSW5wdXQoY20pOyBvbkZvY3VzKGNtKTsgfVxuICB9XG5cbiAgZnVuY3Rpb24gaXNSZWFkT25seShjbSkge1xuICAgIHJldHVybiBjbS5vcHRpb25zLnJlYWRPbmx5IHx8IGNtLmRvYy5jYW50RWRpdDtcbiAgfVxuXG4gIC8vIEVWRU5UIEhBTkRMRVJTXG5cbiAgLy8gQXR0YWNoIHRoZSBuZWNlc3NhcnkgZXZlbnQgaGFuZGxlcnMgd2hlbiBpbml0aWFsaXppbmcgdGhlIGVkaXRvclxuICBmdW5jdGlvbiByZWdpc3RlckV2ZW50SGFuZGxlcnMoY20pIHtcbiAgICB2YXIgZCA9IGNtLmRpc3BsYXk7XG4gICAgb24oZC5zY3JvbGxlciwgXCJtb3VzZWRvd25cIiwgb3BlcmF0aW9uKGNtLCBvbk1vdXNlRG93bikpO1xuICAgIC8vIE9sZGVyIElFJ3Mgd2lsbCBub3QgZmlyZSBhIHNlY29uZCBtb3VzZWRvd24gZm9yIGEgZG91YmxlIGNsaWNrXG4gICAgaWYgKGllICYmIGllX3ZlcnNpb24gPCAxMSlcbiAgICAgIG9uKGQuc2Nyb2xsZXIsIFwiZGJsY2xpY2tcIiwgb3BlcmF0aW9uKGNtLCBmdW5jdGlvbihlKSB7XG4gICAgICAgIGlmIChzaWduYWxET01FdmVudChjbSwgZSkpIHJldHVybjtcbiAgICAgICAgdmFyIHBvcyA9IHBvc0Zyb21Nb3VzZShjbSwgZSk7XG4gICAgICAgIGlmICghcG9zIHx8IGNsaWNrSW5HdXR0ZXIoY20sIGUpIHx8IGV2ZW50SW5XaWRnZXQoY20uZGlzcGxheSwgZSkpIHJldHVybjtcbiAgICAgICAgZV9wcmV2ZW50RGVmYXVsdChlKTtcbiAgICAgICAgdmFyIHdvcmQgPSBmaW5kV29yZEF0KGNtLCBwb3MpO1xuICAgICAgICBleHRlbmRTZWxlY3Rpb24oY20uZG9jLCB3b3JkLmFuY2hvciwgd29yZC5oZWFkKTtcbiAgICAgIH0pKTtcbiAgICBlbHNlXG4gICAgICBvbihkLnNjcm9sbGVyLCBcImRibGNsaWNrXCIsIGZ1bmN0aW9uKGUpIHsgc2lnbmFsRE9NRXZlbnQoY20sIGUpIHx8IGVfcHJldmVudERlZmF1bHQoZSk7IH0pO1xuICAgIC8vIFByZXZlbnQgbm9ybWFsIHNlbGVjdGlvbiBpbiB0aGUgZWRpdG9yICh3ZSBoYW5kbGUgb3VyIG93bilcbiAgICBvbihkLmxpbmVTcGFjZSwgXCJzZWxlY3RzdGFydFwiLCBmdW5jdGlvbihlKSB7XG4gICAgICBpZiAoIWV2ZW50SW5XaWRnZXQoZCwgZSkpIGVfcHJldmVudERlZmF1bHQoZSk7XG4gICAgfSk7XG4gICAgLy8gU29tZSBicm93c2VycyBmaXJlIGNvbnRleHRtZW51ICphZnRlciogb3BlbmluZyB0aGUgbWVudSwgYXRcbiAgICAvLyB3aGljaCBwb2ludCB3ZSBjYW4ndCBtZXNzIHdpdGggaXQgYW55bW9yZS4gQ29udGV4dCBtZW51IGlzXG4gICAgLy8gaGFuZGxlZCBpbiBvbk1vdXNlRG93biBmb3IgdGhlc2UgYnJvd3NlcnMuXG4gICAgaWYgKCFjYXB0dXJlUmlnaHRDbGljaykgb24oZC5zY3JvbGxlciwgXCJjb250ZXh0bWVudVwiLCBmdW5jdGlvbihlKSB7b25Db250ZXh0TWVudShjbSwgZSk7fSk7XG5cbiAgICAvLyBTeW5jIHNjcm9sbGluZyBiZXR3ZWVuIGZha2Ugc2Nyb2xsYmFycyBhbmQgcmVhbCBzY3JvbGxhYmxlXG4gICAgLy8gYXJlYSwgZW5zdXJlIHZpZXdwb3J0IGlzIHVwZGF0ZWQgd2hlbiBzY3JvbGxpbmcuXG4gICAgb24oZC5zY3JvbGxlciwgXCJzY3JvbGxcIiwgZnVuY3Rpb24oKSB7XG4gICAgICBpZiAoZC5zY3JvbGxlci5jbGllbnRIZWlnaHQpIHtcbiAgICAgICAgc2V0U2Nyb2xsVG9wKGNtLCBkLnNjcm9sbGVyLnNjcm9sbFRvcCk7XG4gICAgICAgIHNldFNjcm9sbExlZnQoY20sIGQuc2Nyb2xsZXIuc2Nyb2xsTGVmdCwgdHJ1ZSk7XG4gICAgICAgIHNpZ25hbChjbSwgXCJzY3JvbGxcIiwgY20pO1xuICAgICAgfVxuICAgIH0pO1xuICAgIG9uKGQuc2Nyb2xsYmFyViwgXCJzY3JvbGxcIiwgZnVuY3Rpb24oKSB7XG4gICAgICBpZiAoZC5zY3JvbGxlci5jbGllbnRIZWlnaHQpIHNldFNjcm9sbFRvcChjbSwgZC5zY3JvbGxiYXJWLnNjcm9sbFRvcCk7XG4gICAgfSk7XG4gICAgb24oZC5zY3JvbGxiYXJILCBcInNjcm9sbFwiLCBmdW5jdGlvbigpIHtcbiAgICAgIGlmIChkLnNjcm9sbGVyLmNsaWVudEhlaWdodCkgc2V0U2Nyb2xsTGVmdChjbSwgZC5zY3JvbGxiYXJILnNjcm9sbExlZnQpO1xuICAgIH0pO1xuXG4gICAgLy8gTGlzdGVuIHRvIHdoZWVsIGV2ZW50cyBpbiBvcmRlciB0byB0cnkgYW5kIHVwZGF0ZSB0aGUgdmlld3BvcnQgb24gdGltZS5cbiAgICBvbihkLnNjcm9sbGVyLCBcIm1vdXNld2hlZWxcIiwgZnVuY3Rpb24oZSl7b25TY3JvbGxXaGVlbChjbSwgZSk7fSk7XG4gICAgb24oZC5zY3JvbGxlciwgXCJET01Nb3VzZVNjcm9sbFwiLCBmdW5jdGlvbihlKXtvblNjcm9sbFdoZWVsKGNtLCBlKTt9KTtcblxuICAgIC8vIFByZXZlbnQgY2xpY2tzIGluIHRoZSBzY3JvbGxiYXJzIGZyb20ga2lsbGluZyBmb2N1c1xuICAgIGZ1bmN0aW9uIHJlRm9jdXMoKSB7IGlmIChjbS5zdGF0ZS5mb2N1c2VkKSBzZXRUaW1lb3V0KGJpbmQoZm9jdXNJbnB1dCwgY20pLCAwKTsgfVxuICAgIG9uKGQuc2Nyb2xsYmFySCwgXCJtb3VzZWRvd25cIiwgcmVGb2N1cyk7XG4gICAgb24oZC5zY3JvbGxiYXJWLCBcIm1vdXNlZG93blwiLCByZUZvY3VzKTtcbiAgICAvLyBQcmV2ZW50IHdyYXBwZXIgZnJvbSBldmVyIHNjcm9sbGluZ1xuICAgIG9uKGQud3JhcHBlciwgXCJzY3JvbGxcIiwgZnVuY3Rpb24oKSB7IGQud3JhcHBlci5zY3JvbGxUb3AgPSBkLndyYXBwZXIuc2Nyb2xsTGVmdCA9IDA7IH0pO1xuXG4gICAgb24oZC5pbnB1dCwgXCJrZXl1cFwiLCBmdW5jdGlvbihlKSB7IG9uS2V5VXAuY2FsbChjbSwgZSk7IH0pO1xuICAgIG9uKGQuaW5wdXQsIFwiaW5wdXRcIiwgZnVuY3Rpb24oKSB7XG4gICAgICBpZiAoaWUgJiYgaWVfdmVyc2lvbiA+PSA5ICYmIGNtLmRpc3BsYXkuaW5wdXRIYXNTZWxlY3Rpb24pIGNtLmRpc3BsYXkuaW5wdXRIYXNTZWxlY3Rpb24gPSBudWxsO1xuICAgICAgZmFzdFBvbGwoY20pO1xuICAgIH0pO1xuICAgIG9uKGQuaW5wdXQsIFwia2V5ZG93blwiLCBvcGVyYXRpb24oY20sIG9uS2V5RG93bikpO1xuICAgIG9uKGQuaW5wdXQsIFwia2V5cHJlc3NcIiwgb3BlcmF0aW9uKGNtLCBvbktleVByZXNzKSk7XG4gICAgb24oZC5pbnB1dCwgXCJmb2N1c1wiLCBiaW5kKG9uRm9jdXMsIGNtKSk7XG4gICAgb24oZC5pbnB1dCwgXCJibHVyXCIsIGJpbmQob25CbHVyLCBjbSkpO1xuXG4gICAgZnVuY3Rpb24gZHJhZ18oZSkge1xuICAgICAgaWYgKCFzaWduYWxET01FdmVudChjbSwgZSkpIGVfc3RvcChlKTtcbiAgICB9XG4gICAgaWYgKGNtLm9wdGlvbnMuZHJhZ0Ryb3ApIHtcbiAgICAgIG9uKGQuc2Nyb2xsZXIsIFwiZHJhZ3N0YXJ0XCIsIGZ1bmN0aW9uKGUpe29uRHJhZ1N0YXJ0KGNtLCBlKTt9KTtcbiAgICAgIG9uKGQuc2Nyb2xsZXIsIFwiZHJhZ2VudGVyXCIsIGRyYWdfKTtcbiAgICAgIG9uKGQuc2Nyb2xsZXIsIFwiZHJhZ292ZXJcIiwgZHJhZ18pO1xuICAgICAgb24oZC5zY3JvbGxlciwgXCJkcm9wXCIsIG9wZXJhdGlvbihjbSwgb25Ecm9wKSk7XG4gICAgfVxuICAgIG9uKGQuc2Nyb2xsZXIsIFwicGFzdGVcIiwgZnVuY3Rpb24oZSkge1xuICAgICAgaWYgKGV2ZW50SW5XaWRnZXQoZCwgZSkpIHJldHVybjtcbiAgICAgIGNtLnN0YXRlLnBhc3RlSW5jb21pbmcgPSB0cnVlO1xuICAgICAgZm9jdXNJbnB1dChjbSk7XG4gICAgICBmYXN0UG9sbChjbSk7XG4gICAgfSk7XG4gICAgb24oZC5pbnB1dCwgXCJwYXN0ZVwiLCBmdW5jdGlvbigpIHtcbiAgICAgIC8vIFdvcmthcm91bmQgZm9yIHdlYmtpdCBidWcgaHR0cHM6Ly9idWdzLndlYmtpdC5vcmcvc2hvd19idWcuY2dpP2lkPTkwMjA2XG4gICAgICAvLyBBZGQgYSBjaGFyIHRvIHRoZSBlbmQgb2YgdGV4dGFyZWEgYmVmb3JlIHBhc3RlIG9jY3VyIHNvIHRoYXRcbiAgICAgIC8vIHNlbGVjdGlvbiBkb2Vzbid0IHNwYW4gdG8gdGhlIGVuZCBvZiB0ZXh0YXJlYS5cbiAgICAgIGlmICh3ZWJraXQgJiYgIWNtLnN0YXRlLmZha2VkTGFzdENoYXIgJiYgIShuZXcgRGF0ZSAtIGNtLnN0YXRlLmxhc3RNaWRkbGVEb3duIDwgMjAwKSkge1xuICAgICAgICB2YXIgc3RhcnQgPSBkLmlucHV0LnNlbGVjdGlvblN0YXJ0LCBlbmQgPSBkLmlucHV0LnNlbGVjdGlvbkVuZDtcbiAgICAgICAgZC5pbnB1dC52YWx1ZSArPSBcIiRcIjtcbiAgICAgICAgLy8gVGhlIHNlbGVjdGlvbiBlbmQgbmVlZHMgdG8gYmUgc2V0IGJlZm9yZSB0aGUgc3RhcnQsIG90aGVyd2lzZSB0aGVyZVxuICAgICAgICAvLyBjYW4gYmUgYW4gaW50ZXJtZWRpYXRlIG5vbi1lbXB0eSBzZWxlY3Rpb24gYmV0d2VlbiB0aGUgdHdvLCB3aGljaFxuICAgICAgICAvLyBjYW4gb3ZlcnJpZGUgdGhlIG1pZGRsZS1jbGljayBwYXN0ZSBidWZmZXIgb24gbGludXggYW5kIGNhdXNlIHRoZVxuICAgICAgICAvLyB3cm9uZyB0aGluZyB0byBnZXQgcGFzdGVkLlxuICAgICAgICBkLmlucHV0LnNlbGVjdGlvbkVuZCA9IGVuZDtcbiAgICAgICAgZC5pbnB1dC5zZWxlY3Rpb25TdGFydCA9IHN0YXJ0O1xuICAgICAgICBjbS5zdGF0ZS5mYWtlZExhc3RDaGFyID0gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIGNtLnN0YXRlLnBhc3RlSW5jb21pbmcgPSB0cnVlO1xuICAgICAgZmFzdFBvbGwoY20pO1xuICAgIH0pO1xuXG4gICAgZnVuY3Rpb24gcHJlcGFyZUNvcHlDdXQoZSkge1xuICAgICAgaWYgKGNtLnNvbWV0aGluZ1NlbGVjdGVkKCkpIHtcbiAgICAgICAgbGFzdENvcGllZCA9IGNtLmdldFNlbGVjdGlvbnMoKTtcbiAgICAgICAgaWYgKGQuaW5hY2N1cmF0ZVNlbGVjdGlvbikge1xuICAgICAgICAgIGQucHJldklucHV0ID0gXCJcIjtcbiAgICAgICAgICBkLmluYWNjdXJhdGVTZWxlY3Rpb24gPSBmYWxzZTtcbiAgICAgICAgICBkLmlucHV0LnZhbHVlID0gbGFzdENvcGllZC5qb2luKFwiXFxuXCIpO1xuICAgICAgICAgIHNlbGVjdElucHV0KGQuaW5wdXQpO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB2YXIgdGV4dCA9IFtdLCByYW5nZXMgPSBbXTtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjbS5kb2Muc2VsLnJhbmdlcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgIHZhciBsaW5lID0gY20uZG9jLnNlbC5yYW5nZXNbaV0uaGVhZC5saW5lO1xuICAgICAgICAgIHZhciBsaW5lUmFuZ2UgPSB7YW5jaG9yOiBQb3MobGluZSwgMCksIGhlYWQ6IFBvcyhsaW5lICsgMSwgMCl9O1xuICAgICAgICAgIHJhbmdlcy5wdXNoKGxpbmVSYW5nZSk7XG4gICAgICAgICAgdGV4dC5wdXNoKGNtLmdldFJhbmdlKGxpbmVSYW5nZS5hbmNob3IsIGxpbmVSYW5nZS5oZWFkKSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGUudHlwZSA9PSBcImN1dFwiKSB7XG4gICAgICAgICAgY20uc2V0U2VsZWN0aW9ucyhyYW5nZXMsIG51bGwsIHNlbF9kb250U2Nyb2xsKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBkLnByZXZJbnB1dCA9IFwiXCI7XG4gICAgICAgICAgZC5pbnB1dC52YWx1ZSA9IHRleHQuam9pbihcIlxcblwiKTtcbiAgICAgICAgICBzZWxlY3RJbnB1dChkLmlucHV0KTtcbiAgICAgICAgfVxuICAgICAgICBsYXN0Q29waWVkID0gdGV4dDtcbiAgICAgIH1cbiAgICAgIGlmIChlLnR5cGUgPT0gXCJjdXRcIikgY20uc3RhdGUuY3V0SW5jb21pbmcgPSB0cnVlO1xuICAgIH1cbiAgICBvbihkLmlucHV0LCBcImN1dFwiLCBwcmVwYXJlQ29weUN1dCk7XG4gICAgb24oZC5pbnB1dCwgXCJjb3B5XCIsIHByZXBhcmVDb3B5Q3V0KTtcblxuICAgIC8vIE5lZWRlZCB0byBoYW5kbGUgVGFiIGtleSBpbiBLSFRNTFxuICAgIGlmIChraHRtbCkgb24oZC5zaXplciwgXCJtb3VzZXVwXCIsIGZ1bmN0aW9uKCkge1xuICAgICAgaWYgKGFjdGl2ZUVsdCgpID09IGQuaW5wdXQpIGQuaW5wdXQuYmx1cigpO1xuICAgICAgZm9jdXNJbnB1dChjbSk7XG4gICAgfSk7XG4gIH1cblxuICAvLyBDYWxsZWQgd2hlbiB0aGUgd2luZG93IHJlc2l6ZXNcbiAgZnVuY3Rpb24gb25SZXNpemUoY20pIHtcbiAgICAvLyBNaWdodCBiZSBhIHRleHQgc2NhbGluZyBvcGVyYXRpb24sIGNsZWFyIHNpemUgY2FjaGVzLlxuICAgIHZhciBkID0gY20uZGlzcGxheTtcbiAgICBkLmNhY2hlZENoYXJXaWR0aCA9IGQuY2FjaGVkVGV4dEhlaWdodCA9IGQuY2FjaGVkUGFkZGluZ0ggPSBudWxsO1xuICAgIGNtLnNldFNpemUoKTtcbiAgfVxuXG4gIC8vIE1PVVNFIEVWRU5UU1xuXG4gIC8vIFJldHVybiB0cnVlIHdoZW4gdGhlIGdpdmVuIG1vdXNlIGV2ZW50IGhhcHBlbmVkIGluIGEgd2lkZ2V0XG4gIGZ1bmN0aW9uIGV2ZW50SW5XaWRnZXQoZGlzcGxheSwgZSkge1xuICAgIGZvciAodmFyIG4gPSBlX3RhcmdldChlKTsgbiAhPSBkaXNwbGF5LndyYXBwZXI7IG4gPSBuLnBhcmVudE5vZGUpIHtcbiAgICAgIGlmICghbiB8fCBuLmlnbm9yZUV2ZW50cyB8fCBuLnBhcmVudE5vZGUgPT0gZGlzcGxheS5zaXplciAmJiBuICE9IGRpc3BsYXkubW92ZXIpIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfVxuXG4gIC8vIEdpdmVuIGEgbW91c2UgZXZlbnQsIGZpbmQgdGhlIGNvcnJlc3BvbmRpbmcgcG9zaXRpb24uIElmIGxpYmVyYWxcbiAgLy8gaXMgZmFsc2UsIGl0IGNoZWNrcyB3aGV0aGVyIGEgZ3V0dGVyIG9yIHNjcm9sbGJhciB3YXMgY2xpY2tlZCxcbiAgLy8gYW5kIHJldHVybnMgbnVsbCBpZiBpdCB3YXMuIGZvclJlY3QgaXMgdXNlZCBieSByZWN0YW5ndWxhclxuICAvLyBzZWxlY3Rpb25zLCBhbmQgdHJpZXMgdG8gZXN0aW1hdGUgYSBjaGFyYWN0ZXIgcG9zaXRpb24gZXZlbiBmb3JcbiAgLy8gY29vcmRpbmF0ZXMgYmV5b25kIHRoZSByaWdodCBvZiB0aGUgdGV4dC5cbiAgZnVuY3Rpb24gcG9zRnJvbU1vdXNlKGNtLCBlLCBsaWJlcmFsLCBmb3JSZWN0KSB7XG4gICAgdmFyIGRpc3BsYXkgPSBjbS5kaXNwbGF5O1xuICAgIGlmICghbGliZXJhbCkge1xuICAgICAgdmFyIHRhcmdldCA9IGVfdGFyZ2V0KGUpO1xuICAgICAgaWYgKHRhcmdldCA9PSBkaXNwbGF5LnNjcm9sbGJhckggfHwgdGFyZ2V0ID09IGRpc3BsYXkuc2Nyb2xsYmFyViB8fFxuICAgICAgICAgIHRhcmdldCA9PSBkaXNwbGF5LnNjcm9sbGJhckZpbGxlciB8fCB0YXJnZXQgPT0gZGlzcGxheS5ndXR0ZXJGaWxsZXIpIHJldHVybiBudWxsO1xuICAgIH1cbiAgICB2YXIgeCwgeSwgc3BhY2UgPSBkaXNwbGF5LmxpbmVTcGFjZS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAvLyBGYWlscyB1bnByZWRpY3RhYmx5IG9uIElFWzY3XSB3aGVuIG1vdXNlIGlzIGRyYWdnZWQgYXJvdW5kIHF1aWNrbHkuXG4gICAgdHJ5IHsgeCA9IGUuY2xpZW50WCAtIHNwYWNlLmxlZnQ7IHkgPSBlLmNsaWVudFkgLSBzcGFjZS50b3A7IH1cbiAgICBjYXRjaCAoZSkgeyByZXR1cm4gbnVsbDsgfVxuICAgIHZhciBjb29yZHMgPSBjb29yZHNDaGFyKGNtLCB4LCB5KSwgbGluZTtcbiAgICBpZiAoZm9yUmVjdCAmJiBjb29yZHMueFJlbCA9PSAxICYmIChsaW5lID0gZ2V0TGluZShjbS5kb2MsIGNvb3Jkcy5saW5lKS50ZXh0KS5sZW5ndGggPT0gY29vcmRzLmNoKSB7XG4gICAgICB2YXIgY29sRGlmZiA9IGNvdW50Q29sdW1uKGxpbmUsIGxpbmUubGVuZ3RoLCBjbS5vcHRpb25zLnRhYlNpemUpIC0gbGluZS5sZW5ndGg7XG4gICAgICBjb29yZHMgPSBQb3MoY29vcmRzLmxpbmUsIE1hdGgubWF4KDAsIE1hdGgucm91bmQoKHggLSBwYWRkaW5nSChjbS5kaXNwbGF5KS5sZWZ0KSAvIGNoYXJXaWR0aChjbS5kaXNwbGF5KSkgLSBjb2xEaWZmKSk7XG4gICAgfVxuICAgIHJldHVybiBjb29yZHM7XG4gIH1cblxuICAvLyBBIG1vdXNlIGRvd24gY2FuIGJlIGEgc2luZ2xlIGNsaWNrLCBkb3VibGUgY2xpY2ssIHRyaXBsZSBjbGljayxcbiAgLy8gc3RhcnQgb2Ygc2VsZWN0aW9uIGRyYWcsIHN0YXJ0IG9mIHRleHQgZHJhZywgbmV3IGN1cnNvclxuICAvLyAoY3RybC1jbGljayksIHJlY3RhbmdsZSBkcmFnIChhbHQtZHJhZyksIG9yIHh3aW5cbiAgLy8gbWlkZGxlLWNsaWNrLXBhc3RlLiBPciBpdCBtaWdodCBiZSBhIGNsaWNrIG9uIHNvbWV0aGluZyB3ZSBzaG91bGRcbiAgLy8gbm90IGludGVyZmVyZSB3aXRoLCBzdWNoIGFzIGEgc2Nyb2xsYmFyIG9yIHdpZGdldC5cbiAgZnVuY3Rpb24gb25Nb3VzZURvd24oZSkge1xuICAgIGlmIChzaWduYWxET01FdmVudCh0aGlzLCBlKSkgcmV0dXJuO1xuICAgIHZhciBjbSA9IHRoaXMsIGRpc3BsYXkgPSBjbS5kaXNwbGF5O1xuICAgIGRpc3BsYXkuc2hpZnQgPSBlLnNoaWZ0S2V5O1xuXG4gICAgaWYgKGV2ZW50SW5XaWRnZXQoZGlzcGxheSwgZSkpIHtcbiAgICAgIGlmICghd2Via2l0KSB7XG4gICAgICAgIC8vIEJyaWVmbHkgdHVybiBvZmYgZHJhZ2dhYmlsaXR5LCB0byBhbGxvdyB3aWRnZXRzIHRvIGRvXG4gICAgICAgIC8vIG5vcm1hbCBkcmFnZ2luZyB0aGluZ3MuXG4gICAgICAgIGRpc3BsYXkuc2Nyb2xsZXIuZHJhZ2dhYmxlID0gZmFsc2U7XG4gICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24oKXtkaXNwbGF5LnNjcm9sbGVyLmRyYWdnYWJsZSA9IHRydWU7fSwgMTAwKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKGNsaWNrSW5HdXR0ZXIoY20sIGUpKSByZXR1cm47XG4gICAgdmFyIHN0YXJ0ID0gcG9zRnJvbU1vdXNlKGNtLCBlKTtcbiAgICB3aW5kb3cuZm9jdXMoKTtcblxuICAgIHN3aXRjaCAoZV9idXR0b24oZSkpIHtcbiAgICBjYXNlIDE6XG4gICAgICBpZiAoc3RhcnQpXG4gICAgICAgIGxlZnRCdXR0b25Eb3duKGNtLCBlLCBzdGFydCk7XG4gICAgICBlbHNlIGlmIChlX3RhcmdldChlKSA9PSBkaXNwbGF5LnNjcm9sbGVyKVxuICAgICAgICBlX3ByZXZlbnREZWZhdWx0KGUpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSAyOlxuICAgICAgaWYgKHdlYmtpdCkgY20uc3RhdGUubGFzdE1pZGRsZURvd24gPSArbmV3IERhdGU7XG4gICAgICBpZiAoc3RhcnQpIGV4dGVuZFNlbGVjdGlvbihjbS5kb2MsIHN0YXJ0KTtcbiAgICAgIHNldFRpbWVvdXQoYmluZChmb2N1c0lucHV0LCBjbSksIDIwKTtcbiAgICAgIGVfcHJldmVudERlZmF1bHQoZSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIDM6XG4gICAgICBpZiAoY2FwdHVyZVJpZ2h0Q2xpY2spIG9uQ29udGV4dE1lbnUoY20sIGUpO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgdmFyIGxhc3RDbGljaywgbGFzdERvdWJsZUNsaWNrO1xuICBmdW5jdGlvbiBsZWZ0QnV0dG9uRG93bihjbSwgZSwgc3RhcnQpIHtcbiAgICBzZXRUaW1lb3V0KGJpbmQoZW5zdXJlRm9jdXMsIGNtKSwgMCk7XG5cbiAgICB2YXIgbm93ID0gK25ldyBEYXRlLCB0eXBlO1xuICAgIGlmIChsYXN0RG91YmxlQ2xpY2sgJiYgbGFzdERvdWJsZUNsaWNrLnRpbWUgPiBub3cgLSA0MDAgJiYgY21wKGxhc3REb3VibGVDbGljay5wb3MsIHN0YXJ0KSA9PSAwKSB7XG4gICAgICB0eXBlID0gXCJ0cmlwbGVcIjtcbiAgICB9IGVsc2UgaWYgKGxhc3RDbGljayAmJiBsYXN0Q2xpY2sudGltZSA+IG5vdyAtIDQwMCAmJiBjbXAobGFzdENsaWNrLnBvcywgc3RhcnQpID09IDApIHtcbiAgICAgIHR5cGUgPSBcImRvdWJsZVwiO1xuICAgICAgbGFzdERvdWJsZUNsaWNrID0ge3RpbWU6IG5vdywgcG9zOiBzdGFydH07XG4gICAgfSBlbHNlIHtcbiAgICAgIHR5cGUgPSBcInNpbmdsZVwiO1xuICAgICAgbGFzdENsaWNrID0ge3RpbWU6IG5vdywgcG9zOiBzdGFydH07XG4gICAgfVxuXG4gICAgdmFyIHNlbCA9IGNtLmRvYy5zZWwsIG1vZGlmaWVyID0gbWFjID8gZS5tZXRhS2V5IDogZS5jdHJsS2V5O1xuICAgIGlmIChjbS5vcHRpb25zLmRyYWdEcm9wICYmIGRyYWdBbmREcm9wICYmICFpc1JlYWRPbmx5KGNtKSAmJlxuICAgICAgICB0eXBlID09IFwic2luZ2xlXCIgJiYgc2VsLmNvbnRhaW5zKHN0YXJ0KSA+IC0xICYmIHNlbC5zb21ldGhpbmdTZWxlY3RlZCgpKVxuICAgICAgbGVmdEJ1dHRvblN0YXJ0RHJhZyhjbSwgZSwgc3RhcnQsIG1vZGlmaWVyKTtcbiAgICBlbHNlXG4gICAgICBsZWZ0QnV0dG9uU2VsZWN0KGNtLCBlLCBzdGFydCwgdHlwZSwgbW9kaWZpZXIpO1xuICB9XG5cbiAgLy8gU3RhcnQgYSB0ZXh0IGRyYWcuIFdoZW4gaXQgZW5kcywgc2VlIGlmIGFueSBkcmFnZ2luZyBhY3R1YWxseVxuICAvLyBoYXBwZW4sIGFuZCB0cmVhdCBhcyBhIGNsaWNrIGlmIGl0IGRpZG4ndC5cbiAgZnVuY3Rpb24gbGVmdEJ1dHRvblN0YXJ0RHJhZyhjbSwgZSwgc3RhcnQsIG1vZGlmaWVyKSB7XG4gICAgdmFyIGRpc3BsYXkgPSBjbS5kaXNwbGF5O1xuICAgIHZhciBkcmFnRW5kID0gb3BlcmF0aW9uKGNtLCBmdW5jdGlvbihlMikge1xuICAgICAgaWYgKHdlYmtpdCkgZGlzcGxheS5zY3JvbGxlci5kcmFnZ2FibGUgPSBmYWxzZTtcbiAgICAgIGNtLnN0YXRlLmRyYWdnaW5nVGV4dCA9IGZhbHNlO1xuICAgICAgb2ZmKGRvY3VtZW50LCBcIm1vdXNldXBcIiwgZHJhZ0VuZCk7XG4gICAgICBvZmYoZGlzcGxheS5zY3JvbGxlciwgXCJkcm9wXCIsIGRyYWdFbmQpO1xuICAgICAgaWYgKE1hdGguYWJzKGUuY2xpZW50WCAtIGUyLmNsaWVudFgpICsgTWF0aC5hYnMoZS5jbGllbnRZIC0gZTIuY2xpZW50WSkgPCAxMCkge1xuICAgICAgICBlX3ByZXZlbnREZWZhdWx0KGUyKTtcbiAgICAgICAgaWYgKCFtb2RpZmllcilcbiAgICAgICAgICBleHRlbmRTZWxlY3Rpb24oY20uZG9jLCBzdGFydCk7XG4gICAgICAgIGZvY3VzSW5wdXQoY20pO1xuICAgICAgICAvLyBXb3JrIGFyb3VuZCB1bmV4cGxhaW5hYmxlIGZvY3VzIHByb2JsZW0gaW4gSUU5ICgjMjEyNylcbiAgICAgICAgaWYgKGllICYmIGllX3ZlcnNpb24gPT0gOSlcbiAgICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCkge2RvY3VtZW50LmJvZHkuZm9jdXMoKTsgZm9jdXNJbnB1dChjbSk7fSwgMjApO1xuICAgICAgfVxuICAgIH0pO1xuICAgIC8vIExldCB0aGUgZHJhZyBoYW5kbGVyIGhhbmRsZSB0aGlzLlxuICAgIGlmICh3ZWJraXQpIGRpc3BsYXkuc2Nyb2xsZXIuZHJhZ2dhYmxlID0gdHJ1ZTtcbiAgICBjbS5zdGF0ZS5kcmFnZ2luZ1RleHQgPSBkcmFnRW5kO1xuICAgIC8vIElFJ3MgYXBwcm9hY2ggdG8gZHJhZ2dhYmxlXG4gICAgaWYgKGRpc3BsYXkuc2Nyb2xsZXIuZHJhZ0Ryb3ApIGRpc3BsYXkuc2Nyb2xsZXIuZHJhZ0Ryb3AoKTtcbiAgICBvbihkb2N1bWVudCwgXCJtb3VzZXVwXCIsIGRyYWdFbmQpO1xuICAgIG9uKGRpc3BsYXkuc2Nyb2xsZXIsIFwiZHJvcFwiLCBkcmFnRW5kKTtcbiAgfVxuXG4gIC8vIE5vcm1hbCBzZWxlY3Rpb24sIGFzIG9wcG9zZWQgdG8gdGV4dCBkcmFnZ2luZy5cbiAgZnVuY3Rpb24gbGVmdEJ1dHRvblNlbGVjdChjbSwgZSwgc3RhcnQsIHR5cGUsIGFkZE5ldykge1xuICAgIHZhciBkaXNwbGF5ID0gY20uZGlzcGxheSwgZG9jID0gY20uZG9jO1xuICAgIGVfcHJldmVudERlZmF1bHQoZSk7XG5cbiAgICB2YXIgb3VyUmFuZ2UsIG91ckluZGV4LCBzdGFydFNlbCA9IGRvYy5zZWw7XG4gICAgaWYgKGFkZE5ldyAmJiAhZS5zaGlmdEtleSkge1xuICAgICAgb3VySW5kZXggPSBkb2Muc2VsLmNvbnRhaW5zKHN0YXJ0KTtcbiAgICAgIGlmIChvdXJJbmRleCA+IC0xKVxuICAgICAgICBvdXJSYW5nZSA9IGRvYy5zZWwucmFuZ2VzW291ckluZGV4XTtcbiAgICAgIGVsc2VcbiAgICAgICAgb3VyUmFuZ2UgPSBuZXcgUmFuZ2Uoc3RhcnQsIHN0YXJ0KTtcbiAgICB9IGVsc2Uge1xuICAgICAgb3VyUmFuZ2UgPSBkb2Muc2VsLnByaW1hcnkoKTtcbiAgICB9XG5cbiAgICBpZiAoZS5hbHRLZXkpIHtcbiAgICAgIHR5cGUgPSBcInJlY3RcIjtcbiAgICAgIGlmICghYWRkTmV3KSBvdXJSYW5nZSA9IG5ldyBSYW5nZShzdGFydCwgc3RhcnQpO1xuICAgICAgc3RhcnQgPSBwb3NGcm9tTW91c2UoY20sIGUsIHRydWUsIHRydWUpO1xuICAgICAgb3VySW5kZXggPSAtMTtcbiAgICB9IGVsc2UgaWYgKHR5cGUgPT0gXCJkb3VibGVcIikge1xuICAgICAgdmFyIHdvcmQgPSBmaW5kV29yZEF0KGNtLCBzdGFydCk7XG4gICAgICBpZiAoY20uZGlzcGxheS5zaGlmdCB8fCBkb2MuZXh0ZW5kKVxuICAgICAgICBvdXJSYW5nZSA9IGV4dGVuZFJhbmdlKGRvYywgb3VyUmFuZ2UsIHdvcmQuYW5jaG9yLCB3b3JkLmhlYWQpO1xuICAgICAgZWxzZVxuICAgICAgICBvdXJSYW5nZSA9IHdvcmQ7XG4gICAgfSBlbHNlIGlmICh0eXBlID09IFwidHJpcGxlXCIpIHtcbiAgICAgIHZhciBsaW5lID0gbmV3IFJhbmdlKFBvcyhzdGFydC5saW5lLCAwKSwgY2xpcFBvcyhkb2MsIFBvcyhzdGFydC5saW5lICsgMSwgMCkpKTtcbiAgICAgIGlmIChjbS5kaXNwbGF5LnNoaWZ0IHx8IGRvYy5leHRlbmQpXG4gICAgICAgIG91clJhbmdlID0gZXh0ZW5kUmFuZ2UoZG9jLCBvdXJSYW5nZSwgbGluZS5hbmNob3IsIGxpbmUuaGVhZCk7XG4gICAgICBlbHNlXG4gICAgICAgIG91clJhbmdlID0gbGluZTtcbiAgICB9IGVsc2Uge1xuICAgICAgb3VyUmFuZ2UgPSBleHRlbmRSYW5nZShkb2MsIG91clJhbmdlLCBzdGFydCk7XG4gICAgfVxuXG4gICAgaWYgKCFhZGROZXcpIHtcbiAgICAgIG91ckluZGV4ID0gMDtcbiAgICAgIHNldFNlbGVjdGlvbihkb2MsIG5ldyBTZWxlY3Rpb24oW291clJhbmdlXSwgMCksIHNlbF9tb3VzZSk7XG4gICAgICBzdGFydFNlbCA9IGRvYy5zZWw7XG4gICAgfSBlbHNlIGlmIChvdXJJbmRleCA+IC0xKSB7XG4gICAgICByZXBsYWNlT25lU2VsZWN0aW9uKGRvYywgb3VySW5kZXgsIG91clJhbmdlLCBzZWxfbW91c2UpO1xuICAgIH0gZWxzZSB7XG4gICAgICBvdXJJbmRleCA9IGRvYy5zZWwucmFuZ2VzLmxlbmd0aDtcbiAgICAgIHNldFNlbGVjdGlvbihkb2MsIG5vcm1hbGl6ZVNlbGVjdGlvbihkb2Muc2VsLnJhbmdlcy5jb25jYXQoW291clJhbmdlXSksIG91ckluZGV4KSxcbiAgICAgICAgICAgICAgICAgICB7c2Nyb2xsOiBmYWxzZSwgb3JpZ2luOiBcIiptb3VzZVwifSk7XG4gICAgfVxuXG4gICAgdmFyIGxhc3RQb3MgPSBzdGFydDtcbiAgICBmdW5jdGlvbiBleHRlbmRUbyhwb3MpIHtcbiAgICAgIGlmIChjbXAobGFzdFBvcywgcG9zKSA9PSAwKSByZXR1cm47XG4gICAgICBsYXN0UG9zID0gcG9zO1xuXG4gICAgICBpZiAodHlwZSA9PSBcInJlY3RcIikge1xuICAgICAgICB2YXIgcmFuZ2VzID0gW10sIHRhYlNpemUgPSBjbS5vcHRpb25zLnRhYlNpemU7XG4gICAgICAgIHZhciBzdGFydENvbCA9IGNvdW50Q29sdW1uKGdldExpbmUoZG9jLCBzdGFydC5saW5lKS50ZXh0LCBzdGFydC5jaCwgdGFiU2l6ZSk7XG4gICAgICAgIHZhciBwb3NDb2wgPSBjb3VudENvbHVtbihnZXRMaW5lKGRvYywgcG9zLmxpbmUpLnRleHQsIHBvcy5jaCwgdGFiU2l6ZSk7XG4gICAgICAgIHZhciBsZWZ0ID0gTWF0aC5taW4oc3RhcnRDb2wsIHBvc0NvbCksIHJpZ2h0ID0gTWF0aC5tYXgoc3RhcnRDb2wsIHBvc0NvbCk7XG4gICAgICAgIGZvciAodmFyIGxpbmUgPSBNYXRoLm1pbihzdGFydC5saW5lLCBwb3MubGluZSksIGVuZCA9IE1hdGgubWluKGNtLmxhc3RMaW5lKCksIE1hdGgubWF4KHN0YXJ0LmxpbmUsIHBvcy5saW5lKSk7XG4gICAgICAgICAgICAgbGluZSA8PSBlbmQ7IGxpbmUrKykge1xuICAgICAgICAgIHZhciB0ZXh0ID0gZ2V0TGluZShkb2MsIGxpbmUpLnRleHQsIGxlZnRQb3MgPSBmaW5kQ29sdW1uKHRleHQsIGxlZnQsIHRhYlNpemUpO1xuICAgICAgICAgIGlmIChsZWZ0ID09IHJpZ2h0KVxuICAgICAgICAgICAgcmFuZ2VzLnB1c2gobmV3IFJhbmdlKFBvcyhsaW5lLCBsZWZ0UG9zKSwgUG9zKGxpbmUsIGxlZnRQb3MpKSk7XG4gICAgICAgICAgZWxzZSBpZiAodGV4dC5sZW5ndGggPiBsZWZ0UG9zKVxuICAgICAgICAgICAgcmFuZ2VzLnB1c2gobmV3IFJhbmdlKFBvcyhsaW5lLCBsZWZ0UG9zKSwgUG9zKGxpbmUsIGZpbmRDb2x1bW4odGV4dCwgcmlnaHQsIHRhYlNpemUpKSkpO1xuICAgICAgICB9XG4gICAgICAgIGlmICghcmFuZ2VzLmxlbmd0aCkgcmFuZ2VzLnB1c2gobmV3IFJhbmdlKHN0YXJ0LCBzdGFydCkpO1xuICAgICAgICBzZXRTZWxlY3Rpb24oZG9jLCBub3JtYWxpemVTZWxlY3Rpb24oc3RhcnRTZWwucmFuZ2VzLnNsaWNlKDAsIG91ckluZGV4KS5jb25jYXQocmFuZ2VzKSwgb3VySW5kZXgpLFxuICAgICAgICAgICAgICAgICAgICAge29yaWdpbjogXCIqbW91c2VcIiwgc2Nyb2xsOiBmYWxzZX0pO1xuICAgICAgICBjbS5zY3JvbGxJbnRvVmlldyhwb3MpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIG9sZFJhbmdlID0gb3VyUmFuZ2U7XG4gICAgICAgIHZhciBhbmNob3IgPSBvbGRSYW5nZS5hbmNob3IsIGhlYWQgPSBwb3M7XG4gICAgICAgIGlmICh0eXBlICE9IFwic2luZ2xlXCIpIHtcbiAgICAgICAgICBpZiAodHlwZSA9PSBcImRvdWJsZVwiKVxuICAgICAgICAgICAgdmFyIHJhbmdlID0gZmluZFdvcmRBdChjbSwgcG9zKTtcbiAgICAgICAgICBlbHNlXG4gICAgICAgICAgICB2YXIgcmFuZ2UgPSBuZXcgUmFuZ2UoUG9zKHBvcy5saW5lLCAwKSwgY2xpcFBvcyhkb2MsIFBvcyhwb3MubGluZSArIDEsIDApKSk7XG4gICAgICAgICAgaWYgKGNtcChyYW5nZS5hbmNob3IsIGFuY2hvcikgPiAwKSB7XG4gICAgICAgICAgICBoZWFkID0gcmFuZ2UuaGVhZDtcbiAgICAgICAgICAgIGFuY2hvciA9IG1pblBvcyhvbGRSYW5nZS5mcm9tKCksIHJhbmdlLmFuY2hvcik7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGhlYWQgPSByYW5nZS5hbmNob3I7XG4gICAgICAgICAgICBhbmNob3IgPSBtYXhQb3Mob2xkUmFuZ2UudG8oKSwgcmFuZ2UuaGVhZCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHZhciByYW5nZXMgPSBzdGFydFNlbC5yYW5nZXMuc2xpY2UoMCk7XG4gICAgICAgIHJhbmdlc1tvdXJJbmRleF0gPSBuZXcgUmFuZ2UoY2xpcFBvcyhkb2MsIGFuY2hvciksIGhlYWQpO1xuICAgICAgICBzZXRTZWxlY3Rpb24oZG9jLCBub3JtYWxpemVTZWxlY3Rpb24ocmFuZ2VzLCBvdXJJbmRleCksIHNlbF9tb3VzZSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgdmFyIGVkaXRvclNpemUgPSBkaXNwbGF5LndyYXBwZXIuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgLy8gVXNlZCB0byBlbnN1cmUgdGltZW91dCByZS10cmllcyBkb24ndCBmaXJlIHdoZW4gYW5vdGhlciBleHRlbmRcbiAgICAvLyBoYXBwZW5lZCBpbiB0aGUgbWVhbnRpbWUgKGNsZWFyVGltZW91dCBpc24ndCByZWxpYWJsZSAtLSBhdFxuICAgIC8vIGxlYXN0IG9uIENocm9tZSwgdGhlIHRpbWVvdXRzIHN0aWxsIGhhcHBlbiBldmVuIHdoZW4gY2xlYXJlZCxcbiAgICAvLyBpZiB0aGUgY2xlYXIgaGFwcGVucyBhZnRlciB0aGVpciBzY2hlZHVsZWQgZmlyaW5nIHRpbWUpLlxuICAgIHZhciBjb3VudGVyID0gMDtcblxuICAgIGZ1bmN0aW9uIGV4dGVuZChlKSB7XG4gICAgICB2YXIgY3VyQ291bnQgPSArK2NvdW50ZXI7XG4gICAgICB2YXIgY3VyID0gcG9zRnJvbU1vdXNlKGNtLCBlLCB0cnVlLCB0eXBlID09IFwicmVjdFwiKTtcbiAgICAgIGlmICghY3VyKSByZXR1cm47XG4gICAgICBpZiAoY21wKGN1ciwgbGFzdFBvcykgIT0gMCkge1xuICAgICAgICBlbnN1cmVGb2N1cyhjbSk7XG4gICAgICAgIGV4dGVuZFRvKGN1cik7XG4gICAgICAgIHZhciB2aXNpYmxlID0gdmlzaWJsZUxpbmVzKGRpc3BsYXksIGRvYyk7XG4gICAgICAgIGlmIChjdXIubGluZSA+PSB2aXNpYmxlLnRvIHx8IGN1ci5saW5lIDwgdmlzaWJsZS5mcm9tKVxuICAgICAgICAgIHNldFRpbWVvdXQob3BlcmF0aW9uKGNtLCBmdW5jdGlvbigpe2lmIChjb3VudGVyID09IGN1ckNvdW50KSBleHRlbmQoZSk7fSksIDE1MCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB2YXIgb3V0c2lkZSA9IGUuY2xpZW50WSA8IGVkaXRvclNpemUudG9wID8gLTIwIDogZS5jbGllbnRZID4gZWRpdG9yU2l6ZS5ib3R0b20gPyAyMCA6IDA7XG4gICAgICAgIGlmIChvdXRzaWRlKSBzZXRUaW1lb3V0KG9wZXJhdGlvbihjbSwgZnVuY3Rpb24oKSB7XG4gICAgICAgICAgaWYgKGNvdW50ZXIgIT0gY3VyQ291bnQpIHJldHVybjtcbiAgICAgICAgICBkaXNwbGF5LnNjcm9sbGVyLnNjcm9sbFRvcCArPSBvdXRzaWRlO1xuICAgICAgICAgIGV4dGVuZChlKTtcbiAgICAgICAgfSksIDUwKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBkb25lKGUpIHtcbiAgICAgIGNvdW50ZXIgPSBJbmZpbml0eTtcbiAgICAgIGVfcHJldmVudERlZmF1bHQoZSk7XG4gICAgICBmb2N1c0lucHV0KGNtKTtcbiAgICAgIG9mZihkb2N1bWVudCwgXCJtb3VzZW1vdmVcIiwgbW92ZSk7XG4gICAgICBvZmYoZG9jdW1lbnQsIFwibW91c2V1cFwiLCB1cCk7XG4gICAgICBkb2MuaGlzdG9yeS5sYXN0U2VsT3JpZ2luID0gbnVsbDtcbiAgICB9XG5cbiAgICB2YXIgbW92ZSA9IG9wZXJhdGlvbihjbSwgZnVuY3Rpb24oZSkge1xuICAgICAgaWYgKCFlX2J1dHRvbihlKSkgZG9uZShlKTtcbiAgICAgIGVsc2UgZXh0ZW5kKGUpO1xuICAgIH0pO1xuICAgIHZhciB1cCA9IG9wZXJhdGlvbihjbSwgZG9uZSk7XG4gICAgb24oZG9jdW1lbnQsIFwibW91c2Vtb3ZlXCIsIG1vdmUpO1xuICAgIG9uKGRvY3VtZW50LCBcIm1vdXNldXBcIiwgdXApO1xuICB9XG5cbiAgLy8gRGV0ZXJtaW5lcyB3aGV0aGVyIGFuIGV2ZW50IGhhcHBlbmVkIGluIHRoZSBndXR0ZXIsIGFuZCBmaXJlcyB0aGVcbiAgLy8gaGFuZGxlcnMgZm9yIHRoZSBjb3JyZXNwb25kaW5nIGV2ZW50LlxuICBmdW5jdGlvbiBndXR0ZXJFdmVudChjbSwgZSwgdHlwZSwgcHJldmVudCwgc2lnbmFsZm4pIHtcbiAgICB0cnkgeyB2YXIgbVggPSBlLmNsaWVudFgsIG1ZID0gZS5jbGllbnRZOyB9XG4gICAgY2F0Y2goZSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICBpZiAobVggPj0gTWF0aC5mbG9vcihjbS5kaXNwbGF5Lmd1dHRlcnMuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkucmlnaHQpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKHByZXZlbnQpIGVfcHJldmVudERlZmF1bHQoZSk7XG5cbiAgICB2YXIgZGlzcGxheSA9IGNtLmRpc3BsYXk7XG4gICAgdmFyIGxpbmVCb3ggPSBkaXNwbGF5LmxpbmVEaXYuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG5cbiAgICBpZiAobVkgPiBsaW5lQm94LmJvdHRvbSB8fCAhaGFzSGFuZGxlcihjbSwgdHlwZSkpIHJldHVybiBlX2RlZmF1bHRQcmV2ZW50ZWQoZSk7XG4gICAgbVkgLT0gbGluZUJveC50b3AgLSBkaXNwbGF5LnZpZXdPZmZzZXQ7XG5cbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGNtLm9wdGlvbnMuZ3V0dGVycy5sZW5ndGg7ICsraSkge1xuICAgICAgdmFyIGcgPSBkaXNwbGF5Lmd1dHRlcnMuY2hpbGROb2Rlc1tpXTtcbiAgICAgIGlmIChnICYmIGcuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkucmlnaHQgPj0gbVgpIHtcbiAgICAgICAgdmFyIGxpbmUgPSBsaW5lQXRIZWlnaHQoY20uZG9jLCBtWSk7XG4gICAgICAgIHZhciBndXR0ZXIgPSBjbS5vcHRpb25zLmd1dHRlcnNbaV07XG4gICAgICAgIHNpZ25hbGZuKGNtLCB0eXBlLCBjbSwgbGluZSwgZ3V0dGVyLCBlKTtcbiAgICAgICAgcmV0dXJuIGVfZGVmYXVsdFByZXZlbnRlZChlKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBjbGlja0luR3V0dGVyKGNtLCBlKSB7XG4gICAgcmV0dXJuIGd1dHRlckV2ZW50KGNtLCBlLCBcImd1dHRlckNsaWNrXCIsIHRydWUsIHNpZ25hbExhdGVyKTtcbiAgfVxuXG4gIC8vIEtsdWRnZSB0byB3b3JrIGFyb3VuZCBzdHJhbmdlIElFIGJlaGF2aW9yIHdoZXJlIGl0J2xsIHNvbWV0aW1lc1xuICAvLyByZS1maXJlIGEgc2VyaWVzIG9mIGRyYWctcmVsYXRlZCBldmVudHMgcmlnaHQgYWZ0ZXIgdGhlIGRyb3AgKCMxNTUxKVxuICB2YXIgbGFzdERyb3AgPSAwO1xuXG4gIGZ1bmN0aW9uIG9uRHJvcChlKSB7XG4gICAgdmFyIGNtID0gdGhpcztcbiAgICBpZiAoc2lnbmFsRE9NRXZlbnQoY20sIGUpIHx8IGV2ZW50SW5XaWRnZXQoY20uZGlzcGxheSwgZSkpXG4gICAgICByZXR1cm47XG4gICAgZV9wcmV2ZW50RGVmYXVsdChlKTtcbiAgICBpZiAoaWUpIGxhc3REcm9wID0gK25ldyBEYXRlO1xuICAgIHZhciBwb3MgPSBwb3NGcm9tTW91c2UoY20sIGUsIHRydWUpLCBmaWxlcyA9IGUuZGF0YVRyYW5zZmVyLmZpbGVzO1xuICAgIGlmICghcG9zIHx8IGlzUmVhZE9ubHkoY20pKSByZXR1cm47XG4gICAgLy8gTWlnaHQgYmUgYSBmaWxlIGRyb3AsIGluIHdoaWNoIGNhc2Ugd2Ugc2ltcGx5IGV4dHJhY3QgdGhlIHRleHRcbiAgICAvLyBhbmQgaW5zZXJ0IGl0LlxuICAgIGlmIChmaWxlcyAmJiBmaWxlcy5sZW5ndGggJiYgd2luZG93LkZpbGVSZWFkZXIgJiYgd2luZG93LkZpbGUpIHtcbiAgICAgIHZhciBuID0gZmlsZXMubGVuZ3RoLCB0ZXh0ID0gQXJyYXkobiksIHJlYWQgPSAwO1xuICAgICAgdmFyIGxvYWRGaWxlID0gZnVuY3Rpb24oZmlsZSwgaSkge1xuICAgICAgICB2YXIgcmVhZGVyID0gbmV3IEZpbGVSZWFkZXI7XG4gICAgICAgIHJlYWRlci5vbmxvYWQgPSBvcGVyYXRpb24oY20sIGZ1bmN0aW9uKCkge1xuICAgICAgICAgIHRleHRbaV0gPSByZWFkZXIucmVzdWx0O1xuICAgICAgICAgIGlmICgrK3JlYWQgPT0gbikge1xuICAgICAgICAgICAgcG9zID0gY2xpcFBvcyhjbS5kb2MsIHBvcyk7XG4gICAgICAgICAgICB2YXIgY2hhbmdlID0ge2Zyb206IHBvcywgdG86IHBvcywgdGV4dDogc3BsaXRMaW5lcyh0ZXh0LmpvaW4oXCJcXG5cIikpLCBvcmlnaW46IFwicGFzdGVcIn07XG4gICAgICAgICAgICBtYWtlQ2hhbmdlKGNtLmRvYywgY2hhbmdlKTtcbiAgICAgICAgICAgIHNldFNlbGVjdGlvblJlcGxhY2VIaXN0b3J5KGNtLmRvYywgc2ltcGxlU2VsZWN0aW9uKHBvcywgY2hhbmdlRW5kKGNoYW5nZSkpKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICByZWFkZXIucmVhZEFzVGV4dChmaWxlKTtcbiAgICAgIH07XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IG47ICsraSkgbG9hZEZpbGUoZmlsZXNbaV0sIGkpO1xuICAgIH0gZWxzZSB7IC8vIE5vcm1hbCBkcm9wXG4gICAgICAvLyBEb24ndCBkbyBhIHJlcGxhY2UgaWYgdGhlIGRyb3AgaGFwcGVuZWQgaW5zaWRlIG9mIHRoZSBzZWxlY3RlZCB0ZXh0LlxuICAgICAgaWYgKGNtLnN0YXRlLmRyYWdnaW5nVGV4dCAmJiBjbS5kb2Muc2VsLmNvbnRhaW5zKHBvcykgPiAtMSkge1xuICAgICAgICBjbS5zdGF0ZS5kcmFnZ2luZ1RleHQoZSk7XG4gICAgICAgIC8vIEVuc3VyZSB0aGUgZWRpdG9yIGlzIHJlLWZvY3VzZWRcbiAgICAgICAgc2V0VGltZW91dChiaW5kKGZvY3VzSW5wdXQsIGNtKSwgMjApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICB2YXIgdGV4dCA9IGUuZGF0YVRyYW5zZmVyLmdldERhdGEoXCJUZXh0XCIpO1xuICAgICAgICBpZiAodGV4dCkge1xuICAgICAgICAgIGlmIChjbS5zdGF0ZS5kcmFnZ2luZ1RleHQgJiYgIShtYWMgPyBlLm1ldGFLZXkgOiBlLmN0cmxLZXkpKVxuICAgICAgICAgICAgdmFyIHNlbGVjdGVkID0gY20ubGlzdFNlbGVjdGlvbnMoKTtcbiAgICAgICAgICBzZXRTZWxlY3Rpb25Ob1VuZG8oY20uZG9jLCBzaW1wbGVTZWxlY3Rpb24ocG9zLCBwb3MpKTtcbiAgICAgICAgICBpZiAoc2VsZWN0ZWQpIGZvciAodmFyIGkgPSAwOyBpIDwgc2VsZWN0ZWQubGVuZ3RoOyArK2kpXG4gICAgICAgICAgICByZXBsYWNlUmFuZ2UoY20uZG9jLCBcIlwiLCBzZWxlY3RlZFtpXS5hbmNob3IsIHNlbGVjdGVkW2ldLmhlYWQsIFwiZHJhZ1wiKTtcbiAgICAgICAgICBjbS5yZXBsYWNlU2VsZWN0aW9uKHRleHQsIFwiYXJvdW5kXCIsIFwicGFzdGVcIik7XG4gICAgICAgICAgZm9jdXNJbnB1dChjbSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGNhdGNoKGUpe31cbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBvbkRyYWdTdGFydChjbSwgZSkge1xuICAgIGlmIChpZSAmJiAoIWNtLnN0YXRlLmRyYWdnaW5nVGV4dCB8fCArbmV3IERhdGUgLSBsYXN0RHJvcCA8IDEwMCkpIHsgZV9zdG9wKGUpOyByZXR1cm47IH1cbiAgICBpZiAoc2lnbmFsRE9NRXZlbnQoY20sIGUpIHx8IGV2ZW50SW5XaWRnZXQoY20uZGlzcGxheSwgZSkpIHJldHVybjtcblxuICAgIGUuZGF0YVRyYW5zZmVyLnNldERhdGEoXCJUZXh0XCIsIGNtLmdldFNlbGVjdGlvbigpKTtcblxuICAgIC8vIFVzZSBkdW1teSBpbWFnZSBpbnN0ZWFkIG9mIGRlZmF1bHQgYnJvd3NlcnMgaW1hZ2UuXG4gICAgLy8gUmVjZW50IFNhZmFyaSAofjYuMC4yKSBoYXZlIGEgdGVuZGVuY3kgdG8gc2VnZmF1bHQgd2hlbiB0aGlzIGhhcHBlbnMsIHNvIHdlIGRvbid0IGRvIGl0IHRoZXJlLlxuICAgIGlmIChlLmRhdGFUcmFuc2Zlci5zZXREcmFnSW1hZ2UgJiYgIXNhZmFyaSkge1xuICAgICAgdmFyIGltZyA9IGVsdChcImltZ1wiLCBudWxsLCBudWxsLCBcInBvc2l0aW9uOiBmaXhlZDsgbGVmdDogMDsgdG9wOiAwO1wiKTtcbiAgICAgIGltZy5zcmMgPSBcImRhdGE6aW1hZ2UvZ2lmO2Jhc2U2NCxSMGxHT0RsaEFRQUJBQUFBQUNINUJBRUtBQUVBTEFBQUFBQUJBQUVBQUFJQ1RBRUFPdz09XCI7XG4gICAgICBpZiAocHJlc3RvKSB7XG4gICAgICAgIGltZy53aWR0aCA9IGltZy5oZWlnaHQgPSAxO1xuICAgICAgICBjbS5kaXNwbGF5LndyYXBwZXIuYXBwZW5kQ2hpbGQoaW1nKTtcbiAgICAgICAgLy8gRm9yY2UgYSByZWxheW91dCwgb3IgT3BlcmEgd29uJ3QgdXNlIG91ciBpbWFnZSBmb3Igc29tZSBvYnNjdXJlIHJlYXNvblxuICAgICAgICBpbWcuX3RvcCA9IGltZy5vZmZzZXRUb3A7XG4gICAgICB9XG4gICAgICBlLmRhdGFUcmFuc2Zlci5zZXREcmFnSW1hZ2UoaW1nLCAwLCAwKTtcbiAgICAgIGlmIChwcmVzdG8pIGltZy5wYXJlbnROb2RlLnJlbW92ZUNoaWxkKGltZyk7XG4gICAgfVxuICB9XG5cbiAgLy8gU0NST0xMIEVWRU5UU1xuXG4gIC8vIFN5bmMgdGhlIHNjcm9sbGFibGUgYXJlYSBhbmQgc2Nyb2xsYmFycywgZW5zdXJlIHRoZSB2aWV3cG9ydFxuICAvLyBjb3ZlcnMgdGhlIHZpc2libGUgYXJlYS5cbiAgZnVuY3Rpb24gc2V0U2Nyb2xsVG9wKGNtLCB2YWwpIHtcbiAgICBpZiAoTWF0aC5hYnMoY20uZG9jLnNjcm9sbFRvcCAtIHZhbCkgPCAyKSByZXR1cm47XG4gICAgY20uZG9jLnNjcm9sbFRvcCA9IHZhbDtcbiAgICBpZiAoIWdlY2tvKSB1cGRhdGVEaXNwbGF5U2ltcGxlKGNtLCB7dG9wOiB2YWx9KTtcbiAgICBpZiAoY20uZGlzcGxheS5zY3JvbGxlci5zY3JvbGxUb3AgIT0gdmFsKSBjbS5kaXNwbGF5LnNjcm9sbGVyLnNjcm9sbFRvcCA9IHZhbDtcbiAgICBpZiAoY20uZGlzcGxheS5zY3JvbGxiYXJWLnNjcm9sbFRvcCAhPSB2YWwpIGNtLmRpc3BsYXkuc2Nyb2xsYmFyVi5zY3JvbGxUb3AgPSB2YWw7XG4gICAgaWYgKGdlY2tvKSB1cGRhdGVEaXNwbGF5U2ltcGxlKGNtKTtcbiAgICBzdGFydFdvcmtlcihjbSwgMTAwKTtcbiAgfVxuICAvLyBTeW5jIHNjcm9sbGVyIGFuZCBzY3JvbGxiYXIsIGVuc3VyZSB0aGUgZ3V0dGVyIGVsZW1lbnRzIGFyZVxuICAvLyBhbGlnbmVkLlxuICBmdW5jdGlvbiBzZXRTY3JvbGxMZWZ0KGNtLCB2YWwsIGlzU2Nyb2xsZXIpIHtcbiAgICBpZiAoaXNTY3JvbGxlciA/IHZhbCA9PSBjbS5kb2Muc2Nyb2xsTGVmdCA6IE1hdGguYWJzKGNtLmRvYy5zY3JvbGxMZWZ0IC0gdmFsKSA8IDIpIHJldHVybjtcbiAgICB2YWwgPSBNYXRoLm1pbih2YWwsIGNtLmRpc3BsYXkuc2Nyb2xsZXIuc2Nyb2xsV2lkdGggLSBjbS5kaXNwbGF5LnNjcm9sbGVyLmNsaWVudFdpZHRoKTtcbiAgICBjbS5kb2Muc2Nyb2xsTGVmdCA9IHZhbDtcbiAgICBhbGlnbkhvcml6b250YWxseShjbSk7XG4gICAgaWYgKGNtLmRpc3BsYXkuc2Nyb2xsZXIuc2Nyb2xsTGVmdCAhPSB2YWwpIGNtLmRpc3BsYXkuc2Nyb2xsZXIuc2Nyb2xsTGVmdCA9IHZhbDtcbiAgICBpZiAoY20uZGlzcGxheS5zY3JvbGxiYXJILnNjcm9sbExlZnQgIT0gdmFsKSBjbS5kaXNwbGF5LnNjcm9sbGJhckguc2Nyb2xsTGVmdCA9IHZhbDtcbiAgfVxuXG4gIC8vIFNpbmNlIHRoZSBkZWx0YSB2YWx1ZXMgcmVwb3J0ZWQgb24gbW91c2Ugd2hlZWwgZXZlbnRzIGFyZVxuICAvLyB1bnN0YW5kYXJkaXplZCBiZXR3ZWVuIGJyb3dzZXJzIGFuZCBldmVuIGJyb3dzZXIgdmVyc2lvbnMsIGFuZFxuICAvLyBnZW5lcmFsbHkgaG9ycmlibHkgdW5wcmVkaWN0YWJsZSwgdGhpcyBjb2RlIHN0YXJ0cyBieSBtZWFzdXJpbmdcbiAgLy8gdGhlIHNjcm9sbCBlZmZlY3QgdGhhdCB0aGUgZmlyc3QgZmV3IG1vdXNlIHdoZWVsIGV2ZW50cyBoYXZlLFxuICAvLyBhbmQsIGZyb20gdGhhdCwgZGV0ZWN0cyB0aGUgd2F5IGl0IGNhbiBjb252ZXJ0IGRlbHRhcyB0byBwaXhlbFxuICAvLyBvZmZzZXRzIGFmdGVyd2FyZHMuXG4gIC8vXG4gIC8vIFRoZSByZWFzb24gd2Ugd2FudCB0byBrbm93IHRoZSBhbW91bnQgYSB3aGVlbCBldmVudCB3aWxsIHNjcm9sbFxuICAvLyBpcyB0aGF0IGl0IGdpdmVzIHVzIGEgY2hhbmNlIHRvIHVwZGF0ZSB0aGUgZGlzcGxheSBiZWZvcmUgdGhlXG4gIC8vIGFjdHVhbCBzY3JvbGxpbmcgaGFwcGVucywgcmVkdWNpbmcgZmxpY2tlcmluZy5cblxuICB2YXIgd2hlZWxTYW1wbGVzID0gMCwgd2hlZWxQaXhlbHNQZXJVbml0ID0gbnVsbDtcbiAgLy8gRmlsbCBpbiBhIGJyb3dzZXItZGV0ZWN0ZWQgc3RhcnRpbmcgdmFsdWUgb24gYnJvd3NlcnMgd2hlcmUgd2VcbiAgLy8ga25vdyBvbmUuIFRoZXNlIGRvbid0IGhhdmUgdG8gYmUgYWNjdXJhdGUgLS0gdGhlIHJlc3VsdCBvZiB0aGVtXG4gIC8vIGJlaW5nIHdyb25nIHdvdWxkIGp1c3QgYmUgYSBzbGlnaHQgZmxpY2tlciBvbiB0aGUgZmlyc3Qgd2hlZWxcbiAgLy8gc2Nyb2xsIChpZiBpdCBpcyBsYXJnZSBlbm91Z2gpLlxuICBpZiAoaWUpIHdoZWVsUGl4ZWxzUGVyVW5pdCA9IC0uNTM7XG4gIGVsc2UgaWYgKGdlY2tvKSB3aGVlbFBpeGVsc1BlclVuaXQgPSAxNTtcbiAgZWxzZSBpZiAoY2hyb21lKSB3aGVlbFBpeGVsc1BlclVuaXQgPSAtLjc7XG4gIGVsc2UgaWYgKHNhZmFyaSkgd2hlZWxQaXhlbHNQZXJVbml0ID0gLTEvMztcblxuICBmdW5jdGlvbiBvblNjcm9sbFdoZWVsKGNtLCBlKSB7XG4gICAgdmFyIGR4ID0gZS53aGVlbERlbHRhWCwgZHkgPSBlLndoZWVsRGVsdGFZO1xuICAgIGlmIChkeCA9PSBudWxsICYmIGUuZGV0YWlsICYmIGUuYXhpcyA9PSBlLkhPUklaT05UQUxfQVhJUykgZHggPSBlLmRldGFpbDtcbiAgICBpZiAoZHkgPT0gbnVsbCAmJiBlLmRldGFpbCAmJiBlLmF4aXMgPT0gZS5WRVJUSUNBTF9BWElTKSBkeSA9IGUuZGV0YWlsO1xuICAgIGVsc2UgaWYgKGR5ID09IG51bGwpIGR5ID0gZS53aGVlbERlbHRhO1xuXG4gICAgdmFyIGRpc3BsYXkgPSBjbS5kaXNwbGF5LCBzY3JvbGwgPSBkaXNwbGF5LnNjcm9sbGVyO1xuICAgIC8vIFF1aXQgaWYgdGhlcmUncyBub3RoaW5nIHRvIHNjcm9sbCBoZXJlXG4gICAgaWYgKCEoZHggJiYgc2Nyb2xsLnNjcm9sbFdpZHRoID4gc2Nyb2xsLmNsaWVudFdpZHRoIHx8XG4gICAgICAgICAgZHkgJiYgc2Nyb2xsLnNjcm9sbEhlaWdodCA+IHNjcm9sbC5jbGllbnRIZWlnaHQpKSByZXR1cm47XG5cbiAgICAvLyBXZWJraXQgYnJvd3NlcnMgb24gT1MgWCBhYm9ydCBtb21lbnR1bSBzY3JvbGxzIHdoZW4gdGhlIHRhcmdldFxuICAgIC8vIG9mIHRoZSBzY3JvbGwgZXZlbnQgaXMgcmVtb3ZlZCBmcm9tIHRoZSBzY3JvbGxhYmxlIGVsZW1lbnQuXG4gICAgLy8gVGhpcyBoYWNrIChzZWUgcmVsYXRlZCBjb2RlIGluIHBhdGNoRGlzcGxheSkgbWFrZXMgc3VyZSB0aGVcbiAgICAvLyBlbGVtZW50IGlzIGtlcHQgYXJvdW5kLlxuICAgIGlmIChkeSAmJiBtYWMgJiYgd2Via2l0KSB7XG4gICAgICBvdXRlcjogZm9yICh2YXIgY3VyID0gZS50YXJnZXQsIHZpZXcgPSBkaXNwbGF5LnZpZXc7IGN1ciAhPSBzY3JvbGw7IGN1ciA9IGN1ci5wYXJlbnROb2RlKSB7XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdmlldy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgIGlmICh2aWV3W2ldLm5vZGUgPT0gY3VyKSB7XG4gICAgICAgICAgICBjbS5kaXNwbGF5LmN1cnJlbnRXaGVlbFRhcmdldCA9IGN1cjtcbiAgICAgICAgICAgIGJyZWFrIG91dGVyO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIC8vIE9uIHNvbWUgYnJvd3NlcnMsIGhvcml6b250YWwgc2Nyb2xsaW5nIHdpbGwgY2F1c2UgcmVkcmF3cyB0b1xuICAgIC8vIGhhcHBlbiBiZWZvcmUgdGhlIGd1dHRlciBoYXMgYmVlbiByZWFsaWduZWQsIGNhdXNpbmcgaXQgdG9cbiAgICAvLyB3cmlnZ2xlIGFyb3VuZCBpbiBhIG1vc3QgdW5zZWVtbHkgd2F5LiBXaGVuIHdlIGhhdmUgYW5cbiAgICAvLyBlc3RpbWF0ZWQgcGl4ZWxzL2RlbHRhIHZhbHVlLCB3ZSBqdXN0IGhhbmRsZSBob3Jpem9udGFsXG4gICAgLy8gc2Nyb2xsaW5nIGVudGlyZWx5IGhlcmUuIEl0J2xsIGJlIHNsaWdodGx5IG9mZiBmcm9tIG5hdGl2ZSwgYnV0XG4gICAgLy8gYmV0dGVyIHRoYW4gZ2xpdGNoaW5nIG91dC5cbiAgICBpZiAoZHggJiYgIWdlY2tvICYmICFwcmVzdG8gJiYgd2hlZWxQaXhlbHNQZXJVbml0ICE9IG51bGwpIHtcbiAgICAgIGlmIChkeSlcbiAgICAgICAgc2V0U2Nyb2xsVG9wKGNtLCBNYXRoLm1heCgwLCBNYXRoLm1pbihzY3JvbGwuc2Nyb2xsVG9wICsgZHkgKiB3aGVlbFBpeGVsc1BlclVuaXQsIHNjcm9sbC5zY3JvbGxIZWlnaHQgLSBzY3JvbGwuY2xpZW50SGVpZ2h0KSkpO1xuICAgICAgc2V0U2Nyb2xsTGVmdChjbSwgTWF0aC5tYXgoMCwgTWF0aC5taW4oc2Nyb2xsLnNjcm9sbExlZnQgKyBkeCAqIHdoZWVsUGl4ZWxzUGVyVW5pdCwgc2Nyb2xsLnNjcm9sbFdpZHRoIC0gc2Nyb2xsLmNsaWVudFdpZHRoKSkpO1xuICAgICAgZV9wcmV2ZW50RGVmYXVsdChlKTtcbiAgICAgIGRpc3BsYXkud2hlZWxTdGFydFggPSBudWxsOyAvLyBBYm9ydCBtZWFzdXJlbWVudCwgaWYgaW4gcHJvZ3Jlc3NcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyAnUHJvamVjdCcgdGhlIHZpc2libGUgdmlld3BvcnQgdG8gY292ZXIgdGhlIGFyZWEgdGhhdCBpcyBiZWluZ1xuICAgIC8vIHNjcm9sbGVkIGludG8gdmlldyAoaWYgd2Uga25vdyBlbm91Z2ggdG8gZXN0aW1hdGUgaXQpLlxuICAgIGlmIChkeSAmJiB3aGVlbFBpeGVsc1BlclVuaXQgIT0gbnVsbCkge1xuICAgICAgdmFyIHBpeGVscyA9IGR5ICogd2hlZWxQaXhlbHNQZXJVbml0O1xuICAgICAgdmFyIHRvcCA9IGNtLmRvYy5zY3JvbGxUb3AsIGJvdCA9IHRvcCArIGRpc3BsYXkud3JhcHBlci5jbGllbnRIZWlnaHQ7XG4gICAgICBpZiAocGl4ZWxzIDwgMCkgdG9wID0gTWF0aC5tYXgoMCwgdG9wICsgcGl4ZWxzIC0gNTApO1xuICAgICAgZWxzZSBib3QgPSBNYXRoLm1pbihjbS5kb2MuaGVpZ2h0LCBib3QgKyBwaXhlbHMgKyA1MCk7XG4gICAgICB1cGRhdGVEaXNwbGF5U2ltcGxlKGNtLCB7dG9wOiB0b3AsIGJvdHRvbTogYm90fSk7XG4gICAgfVxuXG4gICAgaWYgKHdoZWVsU2FtcGxlcyA8IDIwKSB7XG4gICAgICBpZiAoZGlzcGxheS53aGVlbFN0YXJ0WCA9PSBudWxsKSB7XG4gICAgICAgIGRpc3BsYXkud2hlZWxTdGFydFggPSBzY3JvbGwuc2Nyb2xsTGVmdDsgZGlzcGxheS53aGVlbFN0YXJ0WSA9IHNjcm9sbC5zY3JvbGxUb3A7XG4gICAgICAgIGRpc3BsYXkud2hlZWxEWCA9IGR4OyBkaXNwbGF5LndoZWVsRFkgPSBkeTtcbiAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgICAgICBpZiAoZGlzcGxheS53aGVlbFN0YXJ0WCA9PSBudWxsKSByZXR1cm47XG4gICAgICAgICAgdmFyIG1vdmVkWCA9IHNjcm9sbC5zY3JvbGxMZWZ0IC0gZGlzcGxheS53aGVlbFN0YXJ0WDtcbiAgICAgICAgICB2YXIgbW92ZWRZID0gc2Nyb2xsLnNjcm9sbFRvcCAtIGRpc3BsYXkud2hlZWxTdGFydFk7XG4gICAgICAgICAgdmFyIHNhbXBsZSA9IChtb3ZlZFkgJiYgZGlzcGxheS53aGVlbERZICYmIG1vdmVkWSAvIGRpc3BsYXkud2hlZWxEWSkgfHxcbiAgICAgICAgICAgIChtb3ZlZFggJiYgZGlzcGxheS53aGVlbERYICYmIG1vdmVkWCAvIGRpc3BsYXkud2hlZWxEWCk7XG4gICAgICAgICAgZGlzcGxheS53aGVlbFN0YXJ0WCA9IGRpc3BsYXkud2hlZWxTdGFydFkgPSBudWxsO1xuICAgICAgICAgIGlmICghc2FtcGxlKSByZXR1cm47XG4gICAgICAgICAgd2hlZWxQaXhlbHNQZXJVbml0ID0gKHdoZWVsUGl4ZWxzUGVyVW5pdCAqIHdoZWVsU2FtcGxlcyArIHNhbXBsZSkgLyAod2hlZWxTYW1wbGVzICsgMSk7XG4gICAgICAgICAgKyt3aGVlbFNhbXBsZXM7XG4gICAgICAgIH0sIDIwMCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBkaXNwbGF5LndoZWVsRFggKz0gZHg7IGRpc3BsYXkud2hlZWxEWSArPSBkeTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBLRVkgRVZFTlRTXG5cbiAgLy8gUnVuIGEgaGFuZGxlciB0aGF0IHdhcyBib3VuZCB0byBhIGtleS5cbiAgZnVuY3Rpb24gZG9IYW5kbGVCaW5kaW5nKGNtLCBib3VuZCwgZHJvcFNoaWZ0KSB7XG4gICAgaWYgKHR5cGVvZiBib3VuZCA9PSBcInN0cmluZ1wiKSB7XG4gICAgICBib3VuZCA9IGNvbW1hbmRzW2JvdW5kXTtcbiAgICAgIGlmICghYm91bmQpIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgLy8gRW5zdXJlIHByZXZpb3VzIGlucHV0IGhhcyBiZWVuIHJlYWQsIHNvIHRoYXQgdGhlIGhhbmRsZXIgc2VlcyBhXG4gICAgLy8gY29uc2lzdGVudCB2aWV3IG9mIHRoZSBkb2N1bWVudFxuICAgIGlmIChjbS5kaXNwbGF5LnBvbGxpbmdGYXN0ICYmIHJlYWRJbnB1dChjbSkpIGNtLmRpc3BsYXkucG9sbGluZ0Zhc3QgPSBmYWxzZTtcbiAgICB2YXIgcHJldlNoaWZ0ID0gY20uZGlzcGxheS5zaGlmdCwgZG9uZSA9IGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICBpZiAoaXNSZWFkT25seShjbSkpIGNtLnN0YXRlLnN1cHByZXNzRWRpdHMgPSB0cnVlO1xuICAgICAgaWYgKGRyb3BTaGlmdCkgY20uZGlzcGxheS5zaGlmdCA9IGZhbHNlO1xuICAgICAgZG9uZSA9IGJvdW5kKGNtKSAhPSBQYXNzO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbS5kaXNwbGF5LnNoaWZ0ID0gcHJldlNoaWZ0O1xuICAgICAgY20uc3RhdGUuc3VwcHJlc3NFZGl0cyA9IGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gZG9uZTtcbiAgfVxuXG4gIC8vIENvbGxlY3QgdGhlIGN1cnJlbnRseSBhY3RpdmUga2V5bWFwcy5cbiAgZnVuY3Rpb24gYWxsS2V5TWFwcyhjbSkge1xuICAgIHZhciBtYXBzID0gY20uc3RhdGUua2V5TWFwcy5zbGljZSgwKTtcbiAgICBpZiAoY20ub3B0aW9ucy5leHRyYUtleXMpIG1hcHMucHVzaChjbS5vcHRpb25zLmV4dHJhS2V5cyk7XG4gICAgbWFwcy5wdXNoKGNtLm9wdGlvbnMua2V5TWFwKTtcbiAgICByZXR1cm4gbWFwcztcbiAgfVxuXG4gIHZhciBtYXliZVRyYW5zaXRpb247XG4gIC8vIEhhbmRsZSBhIGtleSBmcm9tIHRoZSBrZXlkb3duIGV2ZW50LlxuICBmdW5jdGlvbiBoYW5kbGVLZXlCaW5kaW5nKGNtLCBlKSB7XG4gICAgLy8gSGFuZGxlIGF1dG9tYXRpYyBrZXltYXAgdHJhbnNpdGlvbnNcbiAgICB2YXIgc3RhcnRNYXAgPSBnZXRLZXlNYXAoY20ub3B0aW9ucy5rZXlNYXApLCBuZXh0ID0gc3RhcnRNYXAuYXV0bztcbiAgICBjbGVhclRpbWVvdXQobWF5YmVUcmFuc2l0aW9uKTtcbiAgICBpZiAobmV4dCAmJiAhaXNNb2RpZmllcktleShlKSkgbWF5YmVUcmFuc2l0aW9uID0gc2V0VGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgIGlmIChnZXRLZXlNYXAoY20ub3B0aW9ucy5rZXlNYXApID09IHN0YXJ0TWFwKSB7XG4gICAgICAgIGNtLm9wdGlvbnMua2V5TWFwID0gKG5leHQuY2FsbCA/IG5leHQuY2FsbChudWxsLCBjbSkgOiBuZXh0KTtcbiAgICAgICAga2V5TWFwQ2hhbmdlZChjbSk7XG4gICAgICB9XG4gICAgfSwgNTApO1xuXG4gICAgdmFyIG5hbWUgPSBrZXlOYW1lKGUsIHRydWUpLCBoYW5kbGVkID0gZmFsc2U7XG4gICAgaWYgKCFuYW1lKSByZXR1cm4gZmFsc2U7XG4gICAgdmFyIGtleW1hcHMgPSBhbGxLZXlNYXBzKGNtKTtcblxuICAgIGlmIChlLnNoaWZ0S2V5KSB7XG4gICAgICAvLyBGaXJzdCB0cnkgdG8gcmVzb2x2ZSBmdWxsIG5hbWUgKGluY2x1ZGluZyAnU2hpZnQtJykuIEZhaWxpbmdcbiAgICAgIC8vIHRoYXQsIHNlZSBpZiB0aGVyZSBpcyBhIGN1cnNvci1tb3Rpb24gY29tbWFuZCAoc3RhcnRpbmcgd2l0aFxuICAgICAgLy8gJ2dvJykgYm91bmQgdG8gdGhlIGtleW5hbWUgd2l0aG91dCAnU2hpZnQtJy5cbiAgICAgIGhhbmRsZWQgPSBsb29rdXBLZXkoXCJTaGlmdC1cIiArIG5hbWUsIGtleW1hcHMsIGZ1bmN0aW9uKGIpIHtyZXR1cm4gZG9IYW5kbGVCaW5kaW5nKGNtLCBiLCB0cnVlKTt9KVxuICAgICAgICAgICAgIHx8IGxvb2t1cEtleShuYW1lLCBrZXltYXBzLCBmdW5jdGlvbihiKSB7XG4gICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGIgPT0gXCJzdHJpbmdcIiA/IC9eZ29bQS1aXS8udGVzdChiKSA6IGIubW90aW9uKVxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZG9IYW5kbGVCaW5kaW5nKGNtLCBiKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgaGFuZGxlZCA9IGxvb2t1cEtleShuYW1lLCBrZXltYXBzLCBmdW5jdGlvbihiKSB7IHJldHVybiBkb0hhbmRsZUJpbmRpbmcoY20sIGIpOyB9KTtcbiAgICB9XG5cbiAgICBpZiAoaGFuZGxlZCkge1xuICAgICAgZV9wcmV2ZW50RGVmYXVsdChlKTtcbiAgICAgIHJlc3RhcnRCbGluayhjbSk7XG4gICAgICBzaWduYWxMYXRlcihjbSwgXCJrZXlIYW5kbGVkXCIsIGNtLCBuYW1lLCBlKTtcbiAgICB9XG4gICAgcmV0dXJuIGhhbmRsZWQ7XG4gIH1cblxuICAvLyBIYW5kbGUgYSBrZXkgZnJvbSB0aGUga2V5cHJlc3MgZXZlbnRcbiAgZnVuY3Rpb24gaGFuZGxlQ2hhckJpbmRpbmcoY20sIGUsIGNoKSB7XG4gICAgdmFyIGhhbmRsZWQgPSBsb29rdXBLZXkoXCInXCIgKyBjaCArIFwiJ1wiLCBhbGxLZXlNYXBzKGNtKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmdW5jdGlvbihiKSB7IHJldHVybiBkb0hhbmRsZUJpbmRpbmcoY20sIGIsIHRydWUpOyB9KTtcbiAgICBpZiAoaGFuZGxlZCkge1xuICAgICAgZV9wcmV2ZW50RGVmYXVsdChlKTtcbiAgICAgIHJlc3RhcnRCbGluayhjbSk7XG4gICAgICBzaWduYWxMYXRlcihjbSwgXCJrZXlIYW5kbGVkXCIsIGNtLCBcIidcIiArIGNoICsgXCInXCIsIGUpO1xuICAgIH1cbiAgICByZXR1cm4gaGFuZGxlZDtcbiAgfVxuXG4gIHZhciBsYXN0U3RvcHBlZEtleSA9IG51bGw7XG4gIGZ1bmN0aW9uIG9uS2V5RG93bihlKSB7XG4gICAgdmFyIGNtID0gdGhpcztcbiAgICBlbnN1cmVGb2N1cyhjbSk7XG4gICAgaWYgKHNpZ25hbERPTUV2ZW50KGNtLCBlKSkgcmV0dXJuO1xuICAgIC8vIElFIGRvZXMgc3RyYW5nZSB0aGluZ3Mgd2l0aCBlc2NhcGUuXG4gICAgaWYgKGllICYmIGllX3ZlcnNpb24gPCAxMSAmJiBlLmtleUNvZGUgPT0gMjcpIGUucmV0dXJuVmFsdWUgPSBmYWxzZTtcbiAgICB2YXIgY29kZSA9IGUua2V5Q29kZTtcbiAgICBjbS5kaXNwbGF5LnNoaWZ0ID0gY29kZSA9PSAxNiB8fCBlLnNoaWZ0S2V5O1xuICAgIHZhciBoYW5kbGVkID0gaGFuZGxlS2V5QmluZGluZyhjbSwgZSk7XG4gICAgaWYgKHByZXN0bykge1xuICAgICAgbGFzdFN0b3BwZWRLZXkgPSBoYW5kbGVkID8gY29kZSA6IG51bGw7XG4gICAgICAvLyBPcGVyYSBoYXMgbm8gY3V0IGV2ZW50Li4uIHdlIHRyeSB0byBhdCBsZWFzdCBjYXRjaCB0aGUga2V5IGNvbWJvXG4gICAgICBpZiAoIWhhbmRsZWQgJiYgY29kZSA9PSA4OCAmJiAhaGFzQ29weUV2ZW50ICYmIChtYWMgPyBlLm1ldGFLZXkgOiBlLmN0cmxLZXkpKVxuICAgICAgICBjbS5yZXBsYWNlU2VsZWN0aW9uKFwiXCIsIG51bGwsIFwiY3V0XCIpO1xuICAgIH1cblxuICAgIC8vIFR1cm4gbW91c2UgaW50byBjcm9zc2hhaXIgd2hlbiBBbHQgaXMgaGVsZCBvbiBNYWMuXG4gICAgaWYgKGNvZGUgPT0gMTggJiYgIS9cXGJDb2RlTWlycm9yLWNyb3NzaGFpclxcYi8udGVzdChjbS5kaXNwbGF5LmxpbmVEaXYuY2xhc3NOYW1lKSlcbiAgICAgIHNob3dDcm9zc0hhaXIoY20pO1xuICB9XG5cbiAgZnVuY3Rpb24gc2hvd0Nyb3NzSGFpcihjbSkge1xuICAgIHZhciBsaW5lRGl2ID0gY20uZGlzcGxheS5saW5lRGl2O1xuICAgIGFkZENsYXNzKGxpbmVEaXYsIFwiQ29kZU1pcnJvci1jcm9zc2hhaXJcIik7XG5cbiAgICBmdW5jdGlvbiB1cChlKSB7XG4gICAgICBpZiAoZS5rZXlDb2RlID09IDE4IHx8ICFlLmFsdEtleSkge1xuICAgICAgICBybUNsYXNzKGxpbmVEaXYsIFwiQ29kZU1pcnJvci1jcm9zc2hhaXJcIik7XG4gICAgICAgIG9mZihkb2N1bWVudCwgXCJrZXl1cFwiLCB1cCk7XG4gICAgICAgIG9mZihkb2N1bWVudCwgXCJtb3VzZW92ZXJcIiwgdXApO1xuICAgICAgfVxuICAgIH1cbiAgICBvbihkb2N1bWVudCwgXCJrZXl1cFwiLCB1cCk7XG4gICAgb24oZG9jdW1lbnQsIFwibW91c2VvdmVyXCIsIHVwKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIG9uS2V5VXAoZSkge1xuICAgIGlmIChlLmtleUNvZGUgPT0gMTYpIHRoaXMuZG9jLnNlbC5zaGlmdCA9IGZhbHNlO1xuICAgIHNpZ25hbERPTUV2ZW50KHRoaXMsIGUpO1xuICB9XG5cbiAgZnVuY3Rpb24gb25LZXlQcmVzcyhlKSB7XG4gICAgdmFyIGNtID0gdGhpcztcbiAgICBpZiAoc2lnbmFsRE9NRXZlbnQoY20sIGUpIHx8IGUuY3RybEtleSAmJiAhZS5hbHRLZXkgfHwgbWFjICYmIGUubWV0YUtleSkgcmV0dXJuO1xuICAgIHZhciBrZXlDb2RlID0gZS5rZXlDb2RlLCBjaGFyQ29kZSA9IGUuY2hhckNvZGU7XG4gICAgaWYgKHByZXN0byAmJiBrZXlDb2RlID09IGxhc3RTdG9wcGVkS2V5KSB7bGFzdFN0b3BwZWRLZXkgPSBudWxsOyBlX3ByZXZlbnREZWZhdWx0KGUpOyByZXR1cm47fVxuICAgIGlmICgoKHByZXN0byAmJiAoIWUud2hpY2ggfHwgZS53aGljaCA8IDEwKSkgfHwga2h0bWwpICYmIGhhbmRsZUtleUJpbmRpbmcoY20sIGUpKSByZXR1cm47XG4gICAgdmFyIGNoID0gU3RyaW5nLmZyb21DaGFyQ29kZShjaGFyQ29kZSA9PSBudWxsID8ga2V5Q29kZSA6IGNoYXJDb2RlKTtcbiAgICBpZiAoaGFuZGxlQ2hhckJpbmRpbmcoY20sIGUsIGNoKSkgcmV0dXJuO1xuICAgIGlmIChpZSAmJiBpZV92ZXJzaW9uID49IDkpIGNtLmRpc3BsYXkuaW5wdXRIYXNTZWxlY3Rpb24gPSBudWxsO1xuICAgIGZhc3RQb2xsKGNtKTtcbiAgfVxuXG4gIC8vIEZPQ1VTL0JMVVIgRVZFTlRTXG5cbiAgZnVuY3Rpb24gb25Gb2N1cyhjbSkge1xuICAgIGlmIChjbS5vcHRpb25zLnJlYWRPbmx5ID09IFwibm9jdXJzb3JcIikgcmV0dXJuO1xuICAgIGlmICghY20uc3RhdGUuZm9jdXNlZCkge1xuICAgICAgc2lnbmFsKGNtLCBcImZvY3VzXCIsIGNtKTtcbiAgICAgIGNtLnN0YXRlLmZvY3VzZWQgPSB0cnVlO1xuICAgICAgYWRkQ2xhc3MoY20uZGlzcGxheS53cmFwcGVyLCBcIkNvZGVNaXJyb3ItZm9jdXNlZFwiKTtcbiAgICAgIC8vIFRoZSBwcmV2SW5wdXQgdGVzdCBwcmV2ZW50cyB0aGlzIGZyb20gZmlyaW5nIHdoZW4gYSBjb250ZXh0XG4gICAgICAvLyBtZW51IGlzIGNsb3NlZCAoc2luY2UgdGhlIHJlc2V0SW5wdXQgd291bGQga2lsbCB0aGVcbiAgICAgIC8vIHNlbGVjdC1hbGwgZGV0ZWN0aW9uIGhhY2spXG4gICAgICBpZiAoIWNtLmN1ck9wICYmIGNtLmRpc3BsYXkuc2VsRm9yQ29udGV4dE1lbnUgIT0gY20uZG9jLnNlbCkge1xuICAgICAgICByZXNldElucHV0KGNtKTtcbiAgICAgICAgaWYgKHdlYmtpdCkgc2V0VGltZW91dChiaW5kKHJlc2V0SW5wdXQsIGNtLCB0cnVlKSwgMCk7IC8vIElzc3VlICMxNzMwXG4gICAgICB9XG4gICAgfVxuICAgIHNsb3dQb2xsKGNtKTtcbiAgICByZXN0YXJ0QmxpbmsoY20pO1xuICB9XG4gIGZ1bmN0aW9uIG9uQmx1cihjbSkge1xuICAgIGlmIChjbS5zdGF0ZS5mb2N1c2VkKSB7XG4gICAgICBzaWduYWwoY20sIFwiYmx1clwiLCBjbSk7XG4gICAgICBjbS5zdGF0ZS5mb2N1c2VkID0gZmFsc2U7XG4gICAgICBybUNsYXNzKGNtLmRpc3BsYXkud3JhcHBlciwgXCJDb2RlTWlycm9yLWZvY3VzZWRcIik7XG4gICAgfVxuICAgIGNsZWFySW50ZXJ2YWwoY20uZGlzcGxheS5ibGlua2VyKTtcbiAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCkge2lmICghY20uc3RhdGUuZm9jdXNlZCkgY20uZGlzcGxheS5zaGlmdCA9IGZhbHNlO30sIDE1MCk7XG4gIH1cblxuICAvLyBDT05URVhUIE1FTlUgSEFORExJTkdcblxuICAvLyBUbyBtYWtlIHRoZSBjb250ZXh0IG1lbnUgd29yaywgd2UgbmVlZCB0byBicmllZmx5IHVuaGlkZSB0aGVcbiAgLy8gdGV4dGFyZWEgKG1ha2luZyBpdCBhcyB1bm9idHJ1c2l2ZSBhcyBwb3NzaWJsZSkgdG8gbGV0IHRoZVxuICAvLyByaWdodC1jbGljayB0YWtlIGVmZmVjdCBvbiBpdC5cbiAgZnVuY3Rpb24gb25Db250ZXh0TWVudShjbSwgZSkge1xuICAgIGlmIChzaWduYWxET01FdmVudChjbSwgZSwgXCJjb250ZXh0bWVudVwiKSkgcmV0dXJuO1xuICAgIHZhciBkaXNwbGF5ID0gY20uZGlzcGxheTtcbiAgICBpZiAoZXZlbnRJbldpZGdldChkaXNwbGF5LCBlKSB8fCBjb250ZXh0TWVudUluR3V0dGVyKGNtLCBlKSkgcmV0dXJuO1xuXG4gICAgdmFyIHBvcyA9IHBvc0Zyb21Nb3VzZShjbSwgZSksIHNjcm9sbFBvcyA9IGRpc3BsYXkuc2Nyb2xsZXIuc2Nyb2xsVG9wO1xuICAgIGlmICghcG9zIHx8IHByZXN0bykgcmV0dXJuOyAvLyBPcGVyYSBpcyBkaWZmaWN1bHQuXG5cbiAgICAvLyBSZXNldCB0aGUgY3VycmVudCB0ZXh0IHNlbGVjdGlvbiBvbmx5IGlmIHRoZSBjbGljayBpcyBkb25lIG91dHNpZGUgb2YgdGhlIHNlbGVjdGlvblxuICAgIC8vIGFuZCAncmVzZXRTZWxlY3Rpb25PbkNvbnRleHRNZW51JyBvcHRpb24gaXMgdHJ1ZS5cbiAgICB2YXIgcmVzZXQgPSBjbS5vcHRpb25zLnJlc2V0U2VsZWN0aW9uT25Db250ZXh0TWVudTtcbiAgICBpZiAocmVzZXQgJiYgY20uZG9jLnNlbC5jb250YWlucyhwb3MpID09IC0xKVxuICAgICAgb3BlcmF0aW9uKGNtLCBzZXRTZWxlY3Rpb24pKGNtLmRvYywgc2ltcGxlU2VsZWN0aW9uKHBvcyksIHNlbF9kb250U2Nyb2xsKTtcblxuICAgIHZhciBvbGRDU1MgPSBkaXNwbGF5LmlucHV0LnN0eWxlLmNzc1RleHQ7XG4gICAgZGlzcGxheS5pbnB1dERpdi5zdHlsZS5wb3NpdGlvbiA9IFwiYWJzb2x1dGVcIjtcbiAgICBkaXNwbGF5LmlucHV0LnN0eWxlLmNzc1RleHQgPSBcInBvc2l0aW9uOiBmaXhlZDsgd2lkdGg6IDMwcHg7IGhlaWdodDogMzBweDsgdG9wOiBcIiArIChlLmNsaWVudFkgLSA1KSArXG4gICAgICBcInB4OyBsZWZ0OiBcIiArIChlLmNsaWVudFggLSA1KSArIFwicHg7IHotaW5kZXg6IDEwMDA7IGJhY2tncm91bmQ6IFwiICtcbiAgICAgIChpZSA/IFwicmdiYSgyNTUsIDI1NSwgMjU1LCAuMDUpXCIgOiBcInRyYW5zcGFyZW50XCIpICtcbiAgICAgIFwiOyBvdXRsaW5lOiBub25lOyBib3JkZXItd2lkdGg6IDA7IG91dGxpbmU6IG5vbmU7IG92ZXJmbG93OiBoaWRkZW47IG9wYWNpdHk6IC4wNTsgZmlsdGVyOiBhbHBoYShvcGFjaXR5PTUpO1wiO1xuICAgIGlmICh3ZWJraXQpIHZhciBvbGRTY3JvbGxZID0gd2luZG93LnNjcm9sbFk7IC8vIFdvcmsgYXJvdW5kIENocm9tZSBpc3N1ZSAoIzI3MTIpXG4gICAgZm9jdXNJbnB1dChjbSk7XG4gICAgaWYgKHdlYmtpdCkgd2luZG93LnNjcm9sbFRvKG51bGwsIG9sZFNjcm9sbFkpO1xuICAgIHJlc2V0SW5wdXQoY20pO1xuICAgIC8vIEFkZHMgXCJTZWxlY3QgYWxsXCIgdG8gY29udGV4dCBtZW51IGluIEZGXG4gICAgaWYgKCFjbS5zb21ldGhpbmdTZWxlY3RlZCgpKSBkaXNwbGF5LmlucHV0LnZhbHVlID0gZGlzcGxheS5wcmV2SW5wdXQgPSBcIiBcIjtcbiAgICBkaXNwbGF5LnNlbEZvckNvbnRleHRNZW51ID0gY20uZG9jLnNlbDtcbiAgICBjbGVhclRpbWVvdXQoZGlzcGxheS5kZXRlY3RpbmdTZWxlY3RBbGwpO1xuXG4gICAgLy8gU2VsZWN0LWFsbCB3aWxsIGJlIGdyZXllZCBvdXQgaWYgdGhlcmUncyBub3RoaW5nIHRvIHNlbGVjdCwgc29cbiAgICAvLyB0aGlzIGFkZHMgYSB6ZXJvLXdpZHRoIHNwYWNlIHNvIHRoYXQgd2UgY2FuIGxhdGVyIGNoZWNrIHdoZXRoZXJcbiAgICAvLyBpdCBnb3Qgc2VsZWN0ZWQuXG4gICAgZnVuY3Rpb24gcHJlcGFyZVNlbGVjdEFsbEhhY2soKSB7XG4gICAgICBpZiAoZGlzcGxheS5pbnB1dC5zZWxlY3Rpb25TdGFydCAhPSBudWxsKSB7XG4gICAgICAgIHZhciBzZWxlY3RlZCA9IGNtLnNvbWV0aGluZ1NlbGVjdGVkKCk7XG4gICAgICAgIHZhciBleHR2YWwgPSBkaXNwbGF5LmlucHV0LnZhbHVlID0gXCJcXHUyMDBiXCIgKyAoc2VsZWN0ZWQgPyBkaXNwbGF5LmlucHV0LnZhbHVlIDogXCJcIik7XG4gICAgICAgIGRpc3BsYXkucHJldklucHV0ID0gc2VsZWN0ZWQgPyBcIlwiIDogXCJcXHUyMDBiXCI7XG4gICAgICAgIGRpc3BsYXkuaW5wdXQuc2VsZWN0aW9uU3RhcnQgPSAxOyBkaXNwbGF5LmlucHV0LnNlbGVjdGlvbkVuZCA9IGV4dHZhbC5sZW5ndGg7XG4gICAgICAgIC8vIFJlLXNldCB0aGlzLCBpbiBjYXNlIHNvbWUgb3RoZXIgaGFuZGxlciB0b3VjaGVkIHRoZVxuICAgICAgICAvLyBzZWxlY3Rpb24gaW4gdGhlIG1lYW50aW1lLlxuICAgICAgICBkaXNwbGF5LnNlbEZvckNvbnRleHRNZW51ID0gY20uZG9jLnNlbDtcbiAgICAgIH1cbiAgICB9XG4gICAgZnVuY3Rpb24gcmVoaWRlKCkge1xuICAgICAgZGlzcGxheS5pbnB1dERpdi5zdHlsZS5wb3NpdGlvbiA9IFwicmVsYXRpdmVcIjtcbiAgICAgIGRpc3BsYXkuaW5wdXQuc3R5bGUuY3NzVGV4dCA9IG9sZENTUztcbiAgICAgIGlmIChpZSAmJiBpZV92ZXJzaW9uIDwgOSkgZGlzcGxheS5zY3JvbGxiYXJWLnNjcm9sbFRvcCA9IGRpc3BsYXkuc2Nyb2xsZXIuc2Nyb2xsVG9wID0gc2Nyb2xsUG9zO1xuICAgICAgc2xvd1BvbGwoY20pO1xuXG4gICAgICAvLyBUcnkgdG8gZGV0ZWN0IHRoZSB1c2VyIGNob29zaW5nIHNlbGVjdC1hbGxcbiAgICAgIGlmIChkaXNwbGF5LmlucHV0LnNlbGVjdGlvblN0YXJ0ICE9IG51bGwpIHtcbiAgICAgICAgaWYgKCFpZSB8fCAoaWUgJiYgaWVfdmVyc2lvbiA8IDkpKSBwcmVwYXJlU2VsZWN0QWxsSGFjaygpO1xuICAgICAgICB2YXIgaSA9IDAsIHBvbGwgPSBmdW5jdGlvbigpIHtcbiAgICAgICAgICBpZiAoZGlzcGxheS5zZWxGb3JDb250ZXh0TWVudSA9PSBjbS5kb2Muc2VsICYmIGRpc3BsYXkuaW5wdXQuc2VsZWN0aW9uU3RhcnQgPT0gMClcbiAgICAgICAgICAgIG9wZXJhdGlvbihjbSwgY29tbWFuZHMuc2VsZWN0QWxsKShjbSk7XG4gICAgICAgICAgZWxzZSBpZiAoaSsrIDwgMTApIGRpc3BsYXkuZGV0ZWN0aW5nU2VsZWN0QWxsID0gc2V0VGltZW91dChwb2xsLCA1MDApO1xuICAgICAgICAgIGVsc2UgcmVzZXRJbnB1dChjbSk7XG4gICAgICAgIH07XG4gICAgICAgIGRpc3BsYXkuZGV0ZWN0aW5nU2VsZWN0QWxsID0gc2V0VGltZW91dChwb2xsLCAyMDApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChpZSAmJiBpZV92ZXJzaW9uID49IDkpIHByZXBhcmVTZWxlY3RBbGxIYWNrKCk7XG4gICAgaWYgKGNhcHR1cmVSaWdodENsaWNrKSB7XG4gICAgICBlX3N0b3AoZSk7XG4gICAgICB2YXIgbW91c2V1cCA9IGZ1bmN0aW9uKCkge1xuICAgICAgICBvZmYod2luZG93LCBcIm1vdXNldXBcIiwgbW91c2V1cCk7XG4gICAgICAgIHNldFRpbWVvdXQocmVoaWRlLCAyMCk7XG4gICAgICB9O1xuICAgICAgb24od2luZG93LCBcIm1vdXNldXBcIiwgbW91c2V1cCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHNldFRpbWVvdXQocmVoaWRlLCA1MCk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gY29udGV4dE1lbnVJbkd1dHRlcihjbSwgZSkge1xuICAgIGlmICghaGFzSGFuZGxlcihjbSwgXCJndXR0ZXJDb250ZXh0TWVudVwiKSkgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiBndXR0ZXJFdmVudChjbSwgZSwgXCJndXR0ZXJDb250ZXh0TWVudVwiLCBmYWxzZSwgc2lnbmFsKTtcbiAgfVxuXG4gIC8vIFVQREFUSU5HXG5cbiAgLy8gQ29tcHV0ZSB0aGUgcG9zaXRpb24gb2YgdGhlIGVuZCBvZiBhIGNoYW5nZSAoaXRzICd0bycgcHJvcGVydHlcbiAgLy8gcmVmZXJzIHRvIHRoZSBwcmUtY2hhbmdlIGVuZCkuXG4gIHZhciBjaGFuZ2VFbmQgPSBDb2RlTWlycm9yLmNoYW5nZUVuZCA9IGZ1bmN0aW9uKGNoYW5nZSkge1xuICAgIGlmICghY2hhbmdlLnRleHQpIHJldHVybiBjaGFuZ2UudG87XG4gICAgcmV0dXJuIFBvcyhjaGFuZ2UuZnJvbS5saW5lICsgY2hhbmdlLnRleHQubGVuZ3RoIC0gMSxcbiAgICAgICAgICAgICAgIGxzdChjaGFuZ2UudGV4dCkubGVuZ3RoICsgKGNoYW5nZS50ZXh0Lmxlbmd0aCA9PSAxID8gY2hhbmdlLmZyb20uY2ggOiAwKSk7XG4gIH07XG5cbiAgLy8gQWRqdXN0IGEgcG9zaXRpb24gdG8gcmVmZXIgdG8gdGhlIHBvc3QtY2hhbmdlIHBvc2l0aW9uIG9mIHRoZVxuICAvLyBzYW1lIHRleHQsIG9yIHRoZSBlbmQgb2YgdGhlIGNoYW5nZSBpZiB0aGUgY2hhbmdlIGNvdmVycyBpdC5cbiAgZnVuY3Rpb24gYWRqdXN0Rm9yQ2hhbmdlKHBvcywgY2hhbmdlKSB7XG4gICAgaWYgKGNtcChwb3MsIGNoYW5nZS5mcm9tKSA8IDApIHJldHVybiBwb3M7XG4gICAgaWYgKGNtcChwb3MsIGNoYW5nZS50bykgPD0gMCkgcmV0dXJuIGNoYW5nZUVuZChjaGFuZ2UpO1xuXG4gICAgdmFyIGxpbmUgPSBwb3MubGluZSArIGNoYW5nZS50ZXh0Lmxlbmd0aCAtIChjaGFuZ2UudG8ubGluZSAtIGNoYW5nZS5mcm9tLmxpbmUpIC0gMSwgY2ggPSBwb3MuY2g7XG4gICAgaWYgKHBvcy5saW5lID09IGNoYW5nZS50by5saW5lKSBjaCArPSBjaGFuZ2VFbmQoY2hhbmdlKS5jaCAtIGNoYW5nZS50by5jaDtcbiAgICByZXR1cm4gUG9zKGxpbmUsIGNoKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNvbXB1dGVTZWxBZnRlckNoYW5nZShkb2MsIGNoYW5nZSkge1xuICAgIHZhciBvdXQgPSBbXTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGRvYy5zZWwucmFuZ2VzLmxlbmd0aDsgaSsrKSB7XG4gICAgICB2YXIgcmFuZ2UgPSBkb2Muc2VsLnJhbmdlc1tpXTtcbiAgICAgIG91dC5wdXNoKG5ldyBSYW5nZShhZGp1c3RGb3JDaGFuZ2UocmFuZ2UuYW5jaG9yLCBjaGFuZ2UpLFxuICAgICAgICAgICAgICAgICAgICAgICAgIGFkanVzdEZvckNoYW5nZShyYW5nZS5oZWFkLCBjaGFuZ2UpKSk7XG4gICAgfVxuICAgIHJldHVybiBub3JtYWxpemVTZWxlY3Rpb24ob3V0LCBkb2Muc2VsLnByaW1JbmRleCk7XG4gIH1cblxuICBmdW5jdGlvbiBvZmZzZXRQb3MocG9zLCBvbGQsIG53KSB7XG4gICAgaWYgKHBvcy5saW5lID09IG9sZC5saW5lKVxuICAgICAgcmV0dXJuIFBvcyhudy5saW5lLCBwb3MuY2ggLSBvbGQuY2ggKyBudy5jaCk7XG4gICAgZWxzZVxuICAgICAgcmV0dXJuIFBvcyhudy5saW5lICsgKHBvcy5saW5lIC0gb2xkLmxpbmUpLCBwb3MuY2gpO1xuICB9XG5cbiAgLy8gVXNlZCBieSByZXBsYWNlU2VsZWN0aW9ucyB0byBhbGxvdyBtb3ZpbmcgdGhlIHNlbGVjdGlvbiB0byB0aGVcbiAgLy8gc3RhcnQgb3IgYXJvdW5kIHRoZSByZXBsYWNlZCB0ZXN0LiBIaW50IG1heSBiZSBcInN0YXJ0XCIgb3IgXCJhcm91bmRcIi5cbiAgZnVuY3Rpb24gY29tcHV0ZVJlcGxhY2VkU2VsKGRvYywgY2hhbmdlcywgaGludCkge1xuICAgIHZhciBvdXQgPSBbXTtcbiAgICB2YXIgb2xkUHJldiA9IFBvcyhkb2MuZmlyc3QsIDApLCBuZXdQcmV2ID0gb2xkUHJldjtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGNoYW5nZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgIHZhciBjaGFuZ2UgPSBjaGFuZ2VzW2ldO1xuICAgICAgdmFyIGZyb20gPSBvZmZzZXRQb3MoY2hhbmdlLmZyb20sIG9sZFByZXYsIG5ld1ByZXYpO1xuICAgICAgdmFyIHRvID0gb2Zmc2V0UG9zKGNoYW5nZUVuZChjaGFuZ2UpLCBvbGRQcmV2LCBuZXdQcmV2KTtcbiAgICAgIG9sZFByZXYgPSBjaGFuZ2UudG87XG4gICAgICBuZXdQcmV2ID0gdG87XG4gICAgICBpZiAoaGludCA9PSBcImFyb3VuZFwiKSB7XG4gICAgICAgIHZhciByYW5nZSA9IGRvYy5zZWwucmFuZ2VzW2ldLCBpbnYgPSBjbXAocmFuZ2UuaGVhZCwgcmFuZ2UuYW5jaG9yKSA8IDA7XG4gICAgICAgIG91dFtpXSA9IG5ldyBSYW5nZShpbnYgPyB0byA6IGZyb20sIGludiA/IGZyb20gOiB0byk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBvdXRbaV0gPSBuZXcgUmFuZ2UoZnJvbSwgZnJvbSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBuZXcgU2VsZWN0aW9uKG91dCwgZG9jLnNlbC5wcmltSW5kZXgpO1xuICB9XG5cbiAgLy8gQWxsb3cgXCJiZWZvcmVDaGFuZ2VcIiBldmVudCBoYW5kbGVycyB0byBpbmZsdWVuY2UgYSBjaGFuZ2VcbiAgZnVuY3Rpb24gZmlsdGVyQ2hhbmdlKGRvYywgY2hhbmdlLCB1cGRhdGUpIHtcbiAgICB2YXIgb2JqID0ge1xuICAgICAgY2FuY2VsZWQ6IGZhbHNlLFxuICAgICAgZnJvbTogY2hhbmdlLmZyb20sXG4gICAgICB0bzogY2hhbmdlLnRvLFxuICAgICAgdGV4dDogY2hhbmdlLnRleHQsXG4gICAgICBvcmlnaW46IGNoYW5nZS5vcmlnaW4sXG4gICAgICBjYW5jZWw6IGZ1bmN0aW9uKCkgeyB0aGlzLmNhbmNlbGVkID0gdHJ1ZTsgfVxuICAgIH07XG4gICAgaWYgKHVwZGF0ZSkgb2JqLnVwZGF0ZSA9IGZ1bmN0aW9uKGZyb20sIHRvLCB0ZXh0LCBvcmlnaW4pIHtcbiAgICAgIGlmIChmcm9tKSB0aGlzLmZyb20gPSBjbGlwUG9zKGRvYywgZnJvbSk7XG4gICAgICBpZiAodG8pIHRoaXMudG8gPSBjbGlwUG9zKGRvYywgdG8pO1xuICAgICAgaWYgKHRleHQpIHRoaXMudGV4dCA9IHRleHQ7XG4gICAgICBpZiAob3JpZ2luICE9PSB1bmRlZmluZWQpIHRoaXMub3JpZ2luID0gb3JpZ2luO1xuICAgIH07XG4gICAgc2lnbmFsKGRvYywgXCJiZWZvcmVDaGFuZ2VcIiwgZG9jLCBvYmopO1xuICAgIGlmIChkb2MuY20pIHNpZ25hbChkb2MuY20sIFwiYmVmb3JlQ2hhbmdlXCIsIGRvYy5jbSwgb2JqKTtcblxuICAgIGlmIChvYmouY2FuY2VsZWQpIHJldHVybiBudWxsO1xuICAgIHJldHVybiB7ZnJvbTogb2JqLmZyb20sIHRvOiBvYmoudG8sIHRleHQ6IG9iai50ZXh0LCBvcmlnaW46IG9iai5vcmlnaW59O1xuICB9XG5cbiAgLy8gQXBwbHkgYSBjaGFuZ2UgdG8gYSBkb2N1bWVudCwgYW5kIGFkZCBpdCB0byB0aGUgZG9jdW1lbnQnc1xuICAvLyBoaXN0b3J5LCBhbmQgcHJvcGFnYXRpbmcgaXQgdG8gYWxsIGxpbmtlZCBkb2N1bWVudHMuXG4gIGZ1bmN0aW9uIG1ha2VDaGFuZ2UoZG9jLCBjaGFuZ2UsIGlnbm9yZVJlYWRPbmx5KSB7XG4gICAgaWYgKGRvYy5jbSkge1xuICAgICAgaWYgKCFkb2MuY20uY3VyT3ApIHJldHVybiBvcGVyYXRpb24oZG9jLmNtLCBtYWtlQ2hhbmdlKShkb2MsIGNoYW5nZSwgaWdub3JlUmVhZE9ubHkpO1xuICAgICAgaWYgKGRvYy5jbS5zdGF0ZS5zdXBwcmVzc0VkaXRzKSByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKGhhc0hhbmRsZXIoZG9jLCBcImJlZm9yZUNoYW5nZVwiKSB8fCBkb2MuY20gJiYgaGFzSGFuZGxlcihkb2MuY20sIFwiYmVmb3JlQ2hhbmdlXCIpKSB7XG4gICAgICBjaGFuZ2UgPSBmaWx0ZXJDaGFuZ2UoZG9jLCBjaGFuZ2UsIHRydWUpO1xuICAgICAgaWYgKCFjaGFuZ2UpIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBQb3NzaWJseSBzcGxpdCBvciBzdXBwcmVzcyB0aGUgdXBkYXRlIGJhc2VkIG9uIHRoZSBwcmVzZW5jZVxuICAgIC8vIG9mIHJlYWQtb25seSBzcGFucyBpbiBpdHMgcmFuZ2UuXG4gICAgdmFyIHNwbGl0ID0gc2F3UmVhZE9ubHlTcGFucyAmJiAhaWdub3JlUmVhZE9ubHkgJiYgcmVtb3ZlUmVhZE9ubHlSYW5nZXMoZG9jLCBjaGFuZ2UuZnJvbSwgY2hhbmdlLnRvKTtcbiAgICBpZiAoc3BsaXQpIHtcbiAgICAgIGZvciAodmFyIGkgPSBzcGxpdC5sZW5ndGggLSAxOyBpID49IDA7IC0taSlcbiAgICAgICAgbWFrZUNoYW5nZUlubmVyKGRvYywge2Zyb206IHNwbGl0W2ldLmZyb20sIHRvOiBzcGxpdFtpXS50bywgdGV4dDogaSA/IFtcIlwiXSA6IGNoYW5nZS50ZXh0fSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG1ha2VDaGFuZ2VJbm5lcihkb2MsIGNoYW5nZSk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gbWFrZUNoYW5nZUlubmVyKGRvYywgY2hhbmdlKSB7XG4gICAgaWYgKGNoYW5nZS50ZXh0Lmxlbmd0aCA9PSAxICYmIGNoYW5nZS50ZXh0WzBdID09IFwiXCIgJiYgY21wKGNoYW5nZS5mcm9tLCBjaGFuZ2UudG8pID09IDApIHJldHVybjtcbiAgICB2YXIgc2VsQWZ0ZXIgPSBjb21wdXRlU2VsQWZ0ZXJDaGFuZ2UoZG9jLCBjaGFuZ2UpO1xuICAgIGFkZENoYW5nZVRvSGlzdG9yeShkb2MsIGNoYW5nZSwgc2VsQWZ0ZXIsIGRvYy5jbSA/IGRvYy5jbS5jdXJPcC5pZCA6IE5hTik7XG5cbiAgICBtYWtlQ2hhbmdlU2luZ2xlRG9jKGRvYywgY2hhbmdlLCBzZWxBZnRlciwgc3RyZXRjaFNwYW5zT3ZlckNoYW5nZShkb2MsIGNoYW5nZSkpO1xuICAgIHZhciByZWJhc2VkID0gW107XG5cbiAgICBsaW5rZWREb2NzKGRvYywgZnVuY3Rpb24oZG9jLCBzaGFyZWRIaXN0KSB7XG4gICAgICBpZiAoIXNoYXJlZEhpc3QgJiYgaW5kZXhPZihyZWJhc2VkLCBkb2MuaGlzdG9yeSkgPT0gLTEpIHtcbiAgICAgICAgcmViYXNlSGlzdChkb2MuaGlzdG9yeSwgY2hhbmdlKTtcbiAgICAgICAgcmViYXNlZC5wdXNoKGRvYy5oaXN0b3J5KTtcbiAgICAgIH1cbiAgICAgIG1ha2VDaGFuZ2VTaW5nbGVEb2MoZG9jLCBjaGFuZ2UsIG51bGwsIHN0cmV0Y2hTcGFuc092ZXJDaGFuZ2UoZG9jLCBjaGFuZ2UpKTtcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFJldmVydCBhIGNoYW5nZSBzdG9yZWQgaW4gYSBkb2N1bWVudCdzIGhpc3RvcnkuXG4gIGZ1bmN0aW9uIG1ha2VDaGFuZ2VGcm9tSGlzdG9yeShkb2MsIHR5cGUsIGFsbG93U2VsZWN0aW9uT25seSkge1xuICAgIGlmIChkb2MuY20gJiYgZG9jLmNtLnN0YXRlLnN1cHByZXNzRWRpdHMpIHJldHVybjtcblxuICAgIHZhciBoaXN0ID0gZG9jLmhpc3RvcnksIGV2ZW50LCBzZWxBZnRlciA9IGRvYy5zZWw7XG4gICAgdmFyIHNvdXJjZSA9IHR5cGUgPT0gXCJ1bmRvXCIgPyBoaXN0LmRvbmUgOiBoaXN0LnVuZG9uZSwgZGVzdCA9IHR5cGUgPT0gXCJ1bmRvXCIgPyBoaXN0LnVuZG9uZSA6IGhpc3QuZG9uZTtcblxuICAgIC8vIFZlcmlmeSB0aGF0IHRoZXJlIGlzIGEgdXNlYWJsZSBldmVudCAoc28gdGhhdCBjdHJsLXogd29uJ3RcbiAgICAvLyBuZWVkbGVzc2x5IGNsZWFyIHNlbGVjdGlvbiBldmVudHMpXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBzb3VyY2UubGVuZ3RoOyBpKyspIHtcbiAgICAgIGV2ZW50ID0gc291cmNlW2ldO1xuICAgICAgaWYgKGFsbG93U2VsZWN0aW9uT25seSA/IGV2ZW50LnJhbmdlcyAmJiAhZXZlbnQuZXF1YWxzKGRvYy5zZWwpIDogIWV2ZW50LnJhbmdlcylcbiAgICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGlmIChpID09IHNvdXJjZS5sZW5ndGgpIHJldHVybjtcbiAgICBoaXN0Lmxhc3RPcmlnaW4gPSBoaXN0Lmxhc3RTZWxPcmlnaW4gPSBudWxsO1xuXG4gICAgZm9yICg7Oykge1xuICAgICAgZXZlbnQgPSBzb3VyY2UucG9wKCk7XG4gICAgICBpZiAoZXZlbnQucmFuZ2VzKSB7XG4gICAgICAgIHB1c2hTZWxlY3Rpb25Ub0hpc3RvcnkoZXZlbnQsIGRlc3QpO1xuICAgICAgICBpZiAoYWxsb3dTZWxlY3Rpb25Pbmx5ICYmICFldmVudC5lcXVhbHMoZG9jLnNlbCkpIHtcbiAgICAgICAgICBzZXRTZWxlY3Rpb24oZG9jLCBldmVudCwge2NsZWFyUmVkbzogZmFsc2V9KTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgc2VsQWZ0ZXIgPSBldmVudDtcbiAgICAgIH1cbiAgICAgIGVsc2UgYnJlYWs7XG4gICAgfVxuXG4gICAgLy8gQnVpbGQgdXAgYSByZXZlcnNlIGNoYW5nZSBvYmplY3QgdG8gYWRkIHRvIHRoZSBvcHBvc2l0ZSBoaXN0b3J5XG4gICAgLy8gc3RhY2sgKHJlZG8gd2hlbiB1bmRvaW5nLCBhbmQgdmljZSB2ZXJzYSkuXG4gICAgdmFyIGFudGlDaGFuZ2VzID0gW107XG4gICAgcHVzaFNlbGVjdGlvblRvSGlzdG9yeShzZWxBZnRlciwgZGVzdCk7XG4gICAgZGVzdC5wdXNoKHtjaGFuZ2VzOiBhbnRpQ2hhbmdlcywgZ2VuZXJhdGlvbjogaGlzdC5nZW5lcmF0aW9ufSk7XG4gICAgaGlzdC5nZW5lcmF0aW9uID0gZXZlbnQuZ2VuZXJhdGlvbiB8fCArK2hpc3QubWF4R2VuZXJhdGlvbjtcblxuICAgIHZhciBmaWx0ZXIgPSBoYXNIYW5kbGVyKGRvYywgXCJiZWZvcmVDaGFuZ2VcIikgfHwgZG9jLmNtICYmIGhhc0hhbmRsZXIoZG9jLmNtLCBcImJlZm9yZUNoYW5nZVwiKTtcblxuICAgIGZvciAodmFyIGkgPSBldmVudC5jaGFuZ2VzLmxlbmd0aCAtIDE7IGkgPj0gMDsgLS1pKSB7XG4gICAgICB2YXIgY2hhbmdlID0gZXZlbnQuY2hhbmdlc1tpXTtcbiAgICAgIGNoYW5nZS5vcmlnaW4gPSB0eXBlO1xuICAgICAgaWYgKGZpbHRlciAmJiAhZmlsdGVyQ2hhbmdlKGRvYywgY2hhbmdlLCBmYWxzZSkpIHtcbiAgICAgICAgc291cmNlLmxlbmd0aCA9IDA7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgYW50aUNoYW5nZXMucHVzaChoaXN0b3J5Q2hhbmdlRnJvbUNoYW5nZShkb2MsIGNoYW5nZSkpO1xuXG4gICAgICB2YXIgYWZ0ZXIgPSBpID8gY29tcHV0ZVNlbEFmdGVyQ2hhbmdlKGRvYywgY2hhbmdlKSA6IGxzdChzb3VyY2UpO1xuICAgICAgbWFrZUNoYW5nZVNpbmdsZURvYyhkb2MsIGNoYW5nZSwgYWZ0ZXIsIG1lcmdlT2xkU3BhbnMoZG9jLCBjaGFuZ2UpKTtcbiAgICAgIGlmICghaSAmJiBkb2MuY20pIGRvYy5jbS5zY3JvbGxJbnRvVmlldyhjaGFuZ2UpO1xuICAgICAgdmFyIHJlYmFzZWQgPSBbXTtcblxuICAgICAgLy8gUHJvcGFnYXRlIHRvIHRoZSBsaW5rZWQgZG9jdW1lbnRzXG4gICAgICBsaW5rZWREb2NzKGRvYywgZnVuY3Rpb24oZG9jLCBzaGFyZWRIaXN0KSB7XG4gICAgICAgIGlmICghc2hhcmVkSGlzdCAmJiBpbmRleE9mKHJlYmFzZWQsIGRvYy5oaXN0b3J5KSA9PSAtMSkge1xuICAgICAgICAgIHJlYmFzZUhpc3QoZG9jLmhpc3RvcnksIGNoYW5nZSk7XG4gICAgICAgICAgcmViYXNlZC5wdXNoKGRvYy5oaXN0b3J5KTtcbiAgICAgICAgfVxuICAgICAgICBtYWtlQ2hhbmdlU2luZ2xlRG9jKGRvYywgY2hhbmdlLCBudWxsLCBtZXJnZU9sZFNwYW5zKGRvYywgY2hhbmdlKSk7XG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICAvLyBTdWItdmlld3MgbmVlZCB0aGVpciBsaW5lIG51bWJlcnMgc2hpZnRlZCB3aGVuIHRleHQgaXMgYWRkZWRcbiAgLy8gYWJvdmUgb3IgYmVsb3cgdGhlbSBpbiB0aGUgcGFyZW50IGRvY3VtZW50LlxuICBmdW5jdGlvbiBzaGlmdERvYyhkb2MsIGRpc3RhbmNlKSB7XG4gICAgaWYgKGRpc3RhbmNlID09IDApIHJldHVybjtcbiAgICBkb2MuZmlyc3QgKz0gZGlzdGFuY2U7XG4gICAgZG9jLnNlbCA9IG5ldyBTZWxlY3Rpb24obWFwKGRvYy5zZWwucmFuZ2VzLCBmdW5jdGlvbihyYW5nZSkge1xuICAgICAgcmV0dXJuIG5ldyBSYW5nZShQb3MocmFuZ2UuYW5jaG9yLmxpbmUgKyBkaXN0YW5jZSwgcmFuZ2UuYW5jaG9yLmNoKSxcbiAgICAgICAgICAgICAgICAgICAgICAgUG9zKHJhbmdlLmhlYWQubGluZSArIGRpc3RhbmNlLCByYW5nZS5oZWFkLmNoKSk7XG4gICAgfSksIGRvYy5zZWwucHJpbUluZGV4KTtcbiAgICBpZiAoZG9jLmNtKSB7XG4gICAgICByZWdDaGFuZ2UoZG9jLmNtLCBkb2MuZmlyc3QsIGRvYy5maXJzdCAtIGRpc3RhbmNlLCBkaXN0YW5jZSk7XG4gICAgICBmb3IgKHZhciBkID0gZG9jLmNtLmRpc3BsYXksIGwgPSBkLnZpZXdGcm9tOyBsIDwgZC52aWV3VG87IGwrKylcbiAgICAgICAgcmVnTGluZUNoYW5nZShkb2MuY20sIGwsIFwiZ3V0dGVyXCIpO1xuICAgIH1cbiAgfVxuXG4gIC8vIE1vcmUgbG93ZXItbGV2ZWwgY2hhbmdlIGZ1bmN0aW9uLCBoYW5kbGluZyBvbmx5IGEgc2luZ2xlIGRvY3VtZW50XG4gIC8vIChub3QgbGlua2VkIG9uZXMpLlxuICBmdW5jdGlvbiBtYWtlQ2hhbmdlU2luZ2xlRG9jKGRvYywgY2hhbmdlLCBzZWxBZnRlciwgc3BhbnMpIHtcbiAgICBpZiAoZG9jLmNtICYmICFkb2MuY20uY3VyT3ApXG4gICAgICByZXR1cm4gb3BlcmF0aW9uKGRvYy5jbSwgbWFrZUNoYW5nZVNpbmdsZURvYykoZG9jLCBjaGFuZ2UsIHNlbEFmdGVyLCBzcGFucyk7XG5cbiAgICBpZiAoY2hhbmdlLnRvLmxpbmUgPCBkb2MuZmlyc3QpIHtcbiAgICAgIHNoaWZ0RG9jKGRvYywgY2hhbmdlLnRleHQubGVuZ3RoIC0gMSAtIChjaGFuZ2UudG8ubGluZSAtIGNoYW5nZS5mcm9tLmxpbmUpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKGNoYW5nZS5mcm9tLmxpbmUgPiBkb2MubGFzdExpbmUoKSkgcmV0dXJuO1xuXG4gICAgLy8gQ2xpcCB0aGUgY2hhbmdlIHRvIHRoZSBzaXplIG9mIHRoaXMgZG9jXG4gICAgaWYgKGNoYW5nZS5mcm9tLmxpbmUgPCBkb2MuZmlyc3QpIHtcbiAgICAgIHZhciBzaGlmdCA9IGNoYW5nZS50ZXh0Lmxlbmd0aCAtIDEgLSAoZG9jLmZpcnN0IC0gY2hhbmdlLmZyb20ubGluZSk7XG4gICAgICBzaGlmdERvYyhkb2MsIHNoaWZ0KTtcbiAgICAgIGNoYW5nZSA9IHtmcm9tOiBQb3MoZG9jLmZpcnN0LCAwKSwgdG86IFBvcyhjaGFuZ2UudG8ubGluZSArIHNoaWZ0LCBjaGFuZ2UudG8uY2gpLFxuICAgICAgICAgICAgICAgIHRleHQ6IFtsc3QoY2hhbmdlLnRleHQpXSwgb3JpZ2luOiBjaGFuZ2Uub3JpZ2lufTtcbiAgICB9XG4gICAgdmFyIGxhc3QgPSBkb2MubGFzdExpbmUoKTtcbiAgICBpZiAoY2hhbmdlLnRvLmxpbmUgPiBsYXN0KSB7XG4gICAgICBjaGFuZ2UgPSB7ZnJvbTogY2hhbmdlLmZyb20sIHRvOiBQb3MobGFzdCwgZ2V0TGluZShkb2MsIGxhc3QpLnRleHQubGVuZ3RoKSxcbiAgICAgICAgICAgICAgICB0ZXh0OiBbY2hhbmdlLnRleHRbMF1dLCBvcmlnaW46IGNoYW5nZS5vcmlnaW59O1xuICAgIH1cblxuICAgIGNoYW5nZS5yZW1vdmVkID0gZ2V0QmV0d2Vlbihkb2MsIGNoYW5nZS5mcm9tLCBjaGFuZ2UudG8pO1xuXG4gICAgaWYgKCFzZWxBZnRlcikgc2VsQWZ0ZXIgPSBjb21wdXRlU2VsQWZ0ZXJDaGFuZ2UoZG9jLCBjaGFuZ2UpO1xuICAgIGlmIChkb2MuY20pIG1ha2VDaGFuZ2VTaW5nbGVEb2NJbkVkaXRvcihkb2MuY20sIGNoYW5nZSwgc3BhbnMpO1xuICAgIGVsc2UgdXBkYXRlRG9jKGRvYywgY2hhbmdlLCBzcGFucyk7XG4gICAgc2V0U2VsZWN0aW9uTm9VbmRvKGRvYywgc2VsQWZ0ZXIsIHNlbF9kb250U2Nyb2xsKTtcbiAgfVxuXG4gIC8vIEhhbmRsZSB0aGUgaW50ZXJhY3Rpb24gb2YgYSBjaGFuZ2UgdG8gYSBkb2N1bWVudCB3aXRoIHRoZSBlZGl0b3JcbiAgLy8gdGhhdCB0aGlzIGRvY3VtZW50IGlzIHBhcnQgb2YuXG4gIGZ1bmN0aW9uIG1ha2VDaGFuZ2VTaW5nbGVEb2NJbkVkaXRvcihjbSwgY2hhbmdlLCBzcGFucykge1xuICAgIHZhciBkb2MgPSBjbS5kb2MsIGRpc3BsYXkgPSBjbS5kaXNwbGF5LCBmcm9tID0gY2hhbmdlLmZyb20sIHRvID0gY2hhbmdlLnRvO1xuXG4gICAgdmFyIHJlY29tcHV0ZU1heExlbmd0aCA9IGZhbHNlLCBjaGVja1dpZHRoU3RhcnQgPSBmcm9tLmxpbmU7XG4gICAgaWYgKCFjbS5vcHRpb25zLmxpbmVXcmFwcGluZykge1xuICAgICAgY2hlY2tXaWR0aFN0YXJ0ID0gbGluZU5vKHZpc3VhbExpbmUoZ2V0TGluZShkb2MsIGZyb20ubGluZSkpKTtcbiAgICAgIGRvYy5pdGVyKGNoZWNrV2lkdGhTdGFydCwgdG8ubGluZSArIDEsIGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgICAgaWYgKGxpbmUgPT0gZGlzcGxheS5tYXhMaW5lKSB7XG4gICAgICAgICAgcmVjb21wdXRlTWF4TGVuZ3RoID0gdHJ1ZTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKGRvYy5zZWwuY29udGFpbnMoY2hhbmdlLmZyb20sIGNoYW5nZS50bykgPiAtMSlcbiAgICAgIHNpZ25hbEN1cnNvckFjdGl2aXR5KGNtKTtcblxuICAgIHVwZGF0ZURvYyhkb2MsIGNoYW5nZSwgc3BhbnMsIGVzdGltYXRlSGVpZ2h0KGNtKSk7XG5cbiAgICBpZiAoIWNtLm9wdGlvbnMubGluZVdyYXBwaW5nKSB7XG4gICAgICBkb2MuaXRlcihjaGVja1dpZHRoU3RhcnQsIGZyb20ubGluZSArIGNoYW5nZS50ZXh0Lmxlbmd0aCwgZnVuY3Rpb24obGluZSkge1xuICAgICAgICB2YXIgbGVuID0gbGluZUxlbmd0aChsaW5lKTtcbiAgICAgICAgaWYgKGxlbiA+IGRpc3BsYXkubWF4TGluZUxlbmd0aCkge1xuICAgICAgICAgIGRpc3BsYXkubWF4TGluZSA9IGxpbmU7XG4gICAgICAgICAgZGlzcGxheS5tYXhMaW5lTGVuZ3RoID0gbGVuO1xuICAgICAgICAgIGRpc3BsYXkubWF4TGluZUNoYW5nZWQgPSB0cnVlO1xuICAgICAgICAgIHJlY29tcHV0ZU1heExlbmd0aCA9IGZhbHNlO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIGlmIChyZWNvbXB1dGVNYXhMZW5ndGgpIGNtLmN1ck9wLnVwZGF0ZU1heExpbmUgPSB0cnVlO1xuICAgIH1cblxuICAgIC8vIEFkanVzdCBmcm9udGllciwgc2NoZWR1bGUgd29ya2VyXG4gICAgZG9jLmZyb250aWVyID0gTWF0aC5taW4oZG9jLmZyb250aWVyLCBmcm9tLmxpbmUpO1xuICAgIHN0YXJ0V29ya2VyKGNtLCA0MDApO1xuXG4gICAgdmFyIGxlbmRpZmYgPSBjaGFuZ2UudGV4dC5sZW5ndGggLSAodG8ubGluZSAtIGZyb20ubGluZSkgLSAxO1xuICAgIC8vIFJlbWVtYmVyIHRoYXQgdGhlc2UgbGluZXMgY2hhbmdlZCwgZm9yIHVwZGF0aW5nIHRoZSBkaXNwbGF5XG4gICAgaWYgKGZyb20ubGluZSA9PSB0by5saW5lICYmIGNoYW5nZS50ZXh0Lmxlbmd0aCA9PSAxICYmICFpc1dob2xlTGluZVVwZGF0ZShjbS5kb2MsIGNoYW5nZSkpXG4gICAgICByZWdMaW5lQ2hhbmdlKGNtLCBmcm9tLmxpbmUsIFwidGV4dFwiKTtcbiAgICBlbHNlXG4gICAgICByZWdDaGFuZ2UoY20sIGZyb20ubGluZSwgdG8ubGluZSArIDEsIGxlbmRpZmYpO1xuXG4gICAgdmFyIGNoYW5nZXNIYW5kbGVyID0gaGFzSGFuZGxlcihjbSwgXCJjaGFuZ2VzXCIpLCBjaGFuZ2VIYW5kbGVyID0gaGFzSGFuZGxlcihjbSwgXCJjaGFuZ2VcIik7XG4gICAgaWYgKGNoYW5nZUhhbmRsZXIgfHwgY2hhbmdlc0hhbmRsZXIpIHtcbiAgICAgIHZhciBvYmogPSB7XG4gICAgICAgIGZyb206IGZyb20sIHRvOiB0byxcbiAgICAgICAgdGV4dDogY2hhbmdlLnRleHQsXG4gICAgICAgIHJlbW92ZWQ6IGNoYW5nZS5yZW1vdmVkLFxuICAgICAgICBvcmlnaW46IGNoYW5nZS5vcmlnaW5cbiAgICAgIH07XG4gICAgICBpZiAoY2hhbmdlSGFuZGxlcikgc2lnbmFsTGF0ZXIoY20sIFwiY2hhbmdlXCIsIGNtLCBvYmopO1xuICAgICAgaWYgKGNoYW5nZXNIYW5kbGVyKSAoY20uY3VyT3AuY2hhbmdlT2JqcyB8fCAoY20uY3VyT3AuY2hhbmdlT2JqcyA9IFtdKSkucHVzaChvYmopO1xuICAgIH1cbiAgICBjbS5kaXNwbGF5LnNlbEZvckNvbnRleHRNZW51ID0gbnVsbDtcbiAgfVxuXG4gIGZ1bmN0aW9uIHJlcGxhY2VSYW5nZShkb2MsIGNvZGUsIGZyb20sIHRvLCBvcmlnaW4pIHtcbiAgICBpZiAoIXRvKSB0byA9IGZyb207XG4gICAgaWYgKGNtcCh0bywgZnJvbSkgPCAwKSB7IHZhciB0bXAgPSB0bzsgdG8gPSBmcm9tOyBmcm9tID0gdG1wOyB9XG4gICAgaWYgKHR5cGVvZiBjb2RlID09IFwic3RyaW5nXCIpIGNvZGUgPSBzcGxpdExpbmVzKGNvZGUpO1xuICAgIG1ha2VDaGFuZ2UoZG9jLCB7ZnJvbTogZnJvbSwgdG86IHRvLCB0ZXh0OiBjb2RlLCBvcmlnaW46IG9yaWdpbn0pO1xuICB9XG5cbiAgLy8gU0NST0xMSU5HIFRISU5HUyBJTlRPIFZJRVdcblxuICAvLyBJZiBhbiBlZGl0b3Igc2l0cyBvbiB0aGUgdG9wIG9yIGJvdHRvbSBvZiB0aGUgd2luZG93LCBwYXJ0aWFsbHlcbiAgLy8gc2Nyb2xsZWQgb3V0IG9mIHZpZXcsIHRoaXMgZW5zdXJlcyB0aGF0IHRoZSBjdXJzb3IgaXMgdmlzaWJsZS5cbiAgZnVuY3Rpb24gbWF5YmVTY3JvbGxXaW5kb3coY20sIGNvb3Jkcykge1xuICAgIHZhciBkaXNwbGF5ID0gY20uZGlzcGxheSwgYm94ID0gZGlzcGxheS5zaXplci5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKSwgZG9TY3JvbGwgPSBudWxsO1xuICAgIGlmIChjb29yZHMudG9wICsgYm94LnRvcCA8IDApIGRvU2Nyb2xsID0gdHJ1ZTtcbiAgICBlbHNlIGlmIChjb29yZHMuYm90dG9tICsgYm94LnRvcCA+ICh3aW5kb3cuaW5uZXJIZWlnaHQgfHwgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmNsaWVudEhlaWdodCkpIGRvU2Nyb2xsID0gZmFsc2U7XG4gICAgaWYgKGRvU2Nyb2xsICE9IG51bGwgJiYgIXBoYW50b20pIHtcbiAgICAgIHZhciBzY3JvbGxOb2RlID0gZWx0KFwiZGl2XCIsIFwiXFx1MjAwYlwiLCBudWxsLCBcInBvc2l0aW9uOiBhYnNvbHV0ZTsgdG9wOiBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAoY29vcmRzLnRvcCAtIGRpc3BsYXkudmlld09mZnNldCAtIHBhZGRpbmdUb3AoY20uZGlzcGxheSkpICsgXCJweDsgaGVpZ2h0OiBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAoY29vcmRzLmJvdHRvbSAtIGNvb3Jkcy50b3AgKyBzY3JvbGxlckN1dE9mZikgKyBcInB4OyBsZWZ0OiBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICBjb29yZHMubGVmdCArIFwicHg7IHdpZHRoOiAycHg7XCIpO1xuICAgICAgY20uZGlzcGxheS5saW5lU3BhY2UuYXBwZW5kQ2hpbGQoc2Nyb2xsTm9kZSk7XG4gICAgICBzY3JvbGxOb2RlLnNjcm9sbEludG9WaWV3KGRvU2Nyb2xsKTtcbiAgICAgIGNtLmRpc3BsYXkubGluZVNwYWNlLnJlbW92ZUNoaWxkKHNjcm9sbE5vZGUpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFNjcm9sbCBhIGdpdmVuIHBvc2l0aW9uIGludG8gdmlldyAoaW1tZWRpYXRlbHkpLCB2ZXJpZnlpbmcgdGhhdFxuICAvLyBpdCBhY3R1YWxseSBiZWNhbWUgdmlzaWJsZSAoYXMgbGluZSBoZWlnaHRzIGFyZSBhY2N1cmF0ZWx5XG4gIC8vIG1lYXN1cmVkLCB0aGUgcG9zaXRpb24gb2Ygc29tZXRoaW5nIG1heSAnZHJpZnQnIGR1cmluZyBkcmF3aW5nKS5cbiAgZnVuY3Rpb24gc2Nyb2xsUG9zSW50b1ZpZXcoY20sIHBvcywgZW5kLCBtYXJnaW4pIHtcbiAgICBpZiAobWFyZ2luID09IG51bGwpIG1hcmdpbiA9IDA7XG4gICAgZm9yICg7Oykge1xuICAgICAgdmFyIGNoYW5nZWQgPSBmYWxzZSwgY29vcmRzID0gY3Vyc29yQ29vcmRzKGNtLCBwb3MpO1xuICAgICAgdmFyIGVuZENvb3JkcyA9ICFlbmQgfHwgZW5kID09IHBvcyA/IGNvb3JkcyA6IGN1cnNvckNvb3JkcyhjbSwgZW5kKTtcbiAgICAgIHZhciBzY3JvbGxQb3MgPSBjYWxjdWxhdGVTY3JvbGxQb3MoY20sIE1hdGgubWluKGNvb3Jkcy5sZWZ0LCBlbmRDb29yZHMubGVmdCksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIE1hdGgubWluKGNvb3Jkcy50b3AsIGVuZENvb3Jkcy50b3ApIC0gbWFyZ2luLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBNYXRoLm1heChjb29yZHMubGVmdCwgZW5kQ29vcmRzLmxlZnQpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBNYXRoLm1heChjb29yZHMuYm90dG9tLCBlbmRDb29yZHMuYm90dG9tKSArIG1hcmdpbik7XG4gICAgICB2YXIgc3RhcnRUb3AgPSBjbS5kb2Muc2Nyb2xsVG9wLCBzdGFydExlZnQgPSBjbS5kb2Muc2Nyb2xsTGVmdDtcbiAgICAgIGlmIChzY3JvbGxQb3Muc2Nyb2xsVG9wICE9IG51bGwpIHtcbiAgICAgICAgc2V0U2Nyb2xsVG9wKGNtLCBzY3JvbGxQb3Muc2Nyb2xsVG9wKTtcbiAgICAgICAgaWYgKE1hdGguYWJzKGNtLmRvYy5zY3JvbGxUb3AgLSBzdGFydFRvcCkgPiAxKSBjaGFuZ2VkID0gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIGlmIChzY3JvbGxQb3Muc2Nyb2xsTGVmdCAhPSBudWxsKSB7XG4gICAgICAgIHNldFNjcm9sbExlZnQoY20sIHNjcm9sbFBvcy5zY3JvbGxMZWZ0KTtcbiAgICAgICAgaWYgKE1hdGguYWJzKGNtLmRvYy5zY3JvbGxMZWZ0IC0gc3RhcnRMZWZ0KSA+IDEpIGNoYW5nZWQgPSB0cnVlO1xuICAgICAgfVxuICAgICAgaWYgKCFjaGFuZ2VkKSByZXR1cm4gY29vcmRzO1xuICAgIH1cbiAgfVxuXG4gIC8vIFNjcm9sbCBhIGdpdmVuIHNldCBvZiBjb29yZGluYXRlcyBpbnRvIHZpZXcgKGltbWVkaWF0ZWx5KS5cbiAgZnVuY3Rpb24gc2Nyb2xsSW50b1ZpZXcoY20sIHgxLCB5MSwgeDIsIHkyKSB7XG4gICAgdmFyIHNjcm9sbFBvcyA9IGNhbGN1bGF0ZVNjcm9sbFBvcyhjbSwgeDEsIHkxLCB4MiwgeTIpO1xuICAgIGlmIChzY3JvbGxQb3Muc2Nyb2xsVG9wICE9IG51bGwpIHNldFNjcm9sbFRvcChjbSwgc2Nyb2xsUG9zLnNjcm9sbFRvcCk7XG4gICAgaWYgKHNjcm9sbFBvcy5zY3JvbGxMZWZ0ICE9IG51bGwpIHNldFNjcm9sbExlZnQoY20sIHNjcm9sbFBvcy5zY3JvbGxMZWZ0KTtcbiAgfVxuXG4gIC8vIENhbGN1bGF0ZSBhIG5ldyBzY3JvbGwgcG9zaXRpb24gbmVlZGVkIHRvIHNjcm9sbCB0aGUgZ2l2ZW5cbiAgLy8gcmVjdGFuZ2xlIGludG8gdmlldy4gUmV0dXJucyBhbiBvYmplY3Qgd2l0aCBzY3JvbGxUb3AgYW5kXG4gIC8vIHNjcm9sbExlZnQgcHJvcGVydGllcy4gV2hlbiB0aGVzZSBhcmUgdW5kZWZpbmVkLCB0aGVcbiAgLy8gdmVydGljYWwvaG9yaXpvbnRhbCBwb3NpdGlvbiBkb2VzIG5vdCBuZWVkIHRvIGJlIGFkanVzdGVkLlxuICBmdW5jdGlvbiBjYWxjdWxhdGVTY3JvbGxQb3MoY20sIHgxLCB5MSwgeDIsIHkyKSB7XG4gICAgdmFyIGRpc3BsYXkgPSBjbS5kaXNwbGF5LCBzbmFwTWFyZ2luID0gdGV4dEhlaWdodChjbS5kaXNwbGF5KTtcbiAgICBpZiAoeTEgPCAwKSB5MSA9IDA7XG4gICAgdmFyIHNjcmVlbnRvcCA9IGNtLmN1ck9wICYmIGNtLmN1ck9wLnNjcm9sbFRvcCAhPSBudWxsID8gY20uY3VyT3Auc2Nyb2xsVG9wIDogZGlzcGxheS5zY3JvbGxlci5zY3JvbGxUb3A7XG4gICAgdmFyIHNjcmVlbiA9IGRpc3BsYXkuc2Nyb2xsZXIuY2xpZW50SGVpZ2h0IC0gc2Nyb2xsZXJDdXRPZmYsIHJlc3VsdCA9IHt9O1xuICAgIHZhciBkb2NCb3R0b20gPSBjbS5kb2MuaGVpZ2h0ICsgcGFkZGluZ1ZlcnQoZGlzcGxheSk7XG4gICAgdmFyIGF0VG9wID0geTEgPCBzbmFwTWFyZ2luLCBhdEJvdHRvbSA9IHkyID4gZG9jQm90dG9tIC0gc25hcE1hcmdpbjtcbiAgICBpZiAoeTEgPCBzY3JlZW50b3ApIHtcbiAgICAgIHJlc3VsdC5zY3JvbGxUb3AgPSBhdFRvcCA/IDAgOiB5MTtcbiAgICB9IGVsc2UgaWYgKHkyID4gc2NyZWVudG9wICsgc2NyZWVuKSB7XG4gICAgICB2YXIgbmV3VG9wID0gTWF0aC5taW4oeTEsIChhdEJvdHRvbSA/IGRvY0JvdHRvbSA6IHkyKSAtIHNjcmVlbik7XG4gICAgICBpZiAobmV3VG9wICE9IHNjcmVlbnRvcCkgcmVzdWx0LnNjcm9sbFRvcCA9IG5ld1RvcDtcbiAgICB9XG5cbiAgICB2YXIgc2NyZWVubGVmdCA9IGNtLmN1ck9wICYmIGNtLmN1ck9wLnNjcm9sbExlZnQgIT0gbnVsbCA/IGNtLmN1ck9wLnNjcm9sbExlZnQgOiBkaXNwbGF5LnNjcm9sbGVyLnNjcm9sbExlZnQ7XG4gICAgdmFyIHNjcmVlbncgPSBkaXNwbGF5LnNjcm9sbGVyLmNsaWVudFdpZHRoIC0gc2Nyb2xsZXJDdXRPZmY7XG4gICAgeDEgKz0gZGlzcGxheS5ndXR0ZXJzLm9mZnNldFdpZHRoOyB4MiArPSBkaXNwbGF5Lmd1dHRlcnMub2Zmc2V0V2lkdGg7XG4gICAgdmFyIGd1dHRlcncgPSBkaXNwbGF5Lmd1dHRlcnMub2Zmc2V0V2lkdGg7XG4gICAgdmFyIGF0TGVmdCA9IHgxIDwgZ3V0dGVydyArIDEwO1xuICAgIGlmICh4MSA8IHNjcmVlbmxlZnQgKyBndXR0ZXJ3IHx8IGF0TGVmdCkge1xuICAgICAgaWYgKGF0TGVmdCkgeDEgPSAwO1xuICAgICAgcmVzdWx0LnNjcm9sbExlZnQgPSBNYXRoLm1heCgwLCB4MSAtIDEwIC0gZ3V0dGVydyk7XG4gICAgfSBlbHNlIGlmICh4MiA+IHNjcmVlbncgKyBzY3JlZW5sZWZ0IC0gMykge1xuICAgICAgcmVzdWx0LnNjcm9sbExlZnQgPSB4MiArIDEwIC0gc2NyZWVudztcbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIC8vIFN0b3JlIGEgcmVsYXRpdmUgYWRqdXN0bWVudCB0byB0aGUgc2Nyb2xsIHBvc2l0aW9uIGluIHRoZSBjdXJyZW50XG4gIC8vIG9wZXJhdGlvbiAodG8gYmUgYXBwbGllZCB3aGVuIHRoZSBvcGVyYXRpb24gZmluaXNoZXMpLlxuICBmdW5jdGlvbiBhZGRUb1Njcm9sbFBvcyhjbSwgbGVmdCwgdG9wKSB7XG4gICAgaWYgKGxlZnQgIT0gbnVsbCB8fCB0b3AgIT0gbnVsbCkgcmVzb2x2ZVNjcm9sbFRvUG9zKGNtKTtcbiAgICBpZiAobGVmdCAhPSBudWxsKVxuICAgICAgY20uY3VyT3Auc2Nyb2xsTGVmdCA9IChjbS5jdXJPcC5zY3JvbGxMZWZ0ID09IG51bGwgPyBjbS5kb2Muc2Nyb2xsTGVmdCA6IGNtLmN1ck9wLnNjcm9sbExlZnQpICsgbGVmdDtcbiAgICBpZiAodG9wICE9IG51bGwpXG4gICAgICBjbS5jdXJPcC5zY3JvbGxUb3AgPSAoY20uY3VyT3Auc2Nyb2xsVG9wID09IG51bGwgPyBjbS5kb2Muc2Nyb2xsVG9wIDogY20uY3VyT3Auc2Nyb2xsVG9wKSArIHRvcDtcbiAgfVxuXG4gIC8vIE1ha2Ugc3VyZSB0aGF0IGF0IHRoZSBlbmQgb2YgdGhlIG9wZXJhdGlvbiB0aGUgY3VycmVudCBjdXJzb3IgaXNcbiAgLy8gc2hvd24uXG4gIGZ1bmN0aW9uIGVuc3VyZUN1cnNvclZpc2libGUoY20pIHtcbiAgICByZXNvbHZlU2Nyb2xsVG9Qb3MoY20pO1xuICAgIHZhciBjdXIgPSBjbS5nZXRDdXJzb3IoKSwgZnJvbSA9IGN1ciwgdG8gPSBjdXI7XG4gICAgaWYgKCFjbS5vcHRpb25zLmxpbmVXcmFwcGluZykge1xuICAgICAgZnJvbSA9IGN1ci5jaCA/IFBvcyhjdXIubGluZSwgY3VyLmNoIC0gMSkgOiBjdXI7XG4gICAgICB0byA9IFBvcyhjdXIubGluZSwgY3VyLmNoICsgMSk7XG4gICAgfVxuICAgIGNtLmN1ck9wLnNjcm9sbFRvUG9zID0ge2Zyb206IGZyb20sIHRvOiB0bywgbWFyZ2luOiBjbS5vcHRpb25zLmN1cnNvclNjcm9sbE1hcmdpbiwgaXNDdXJzb3I6IHRydWV9O1xuICB9XG5cbiAgLy8gV2hlbiBhbiBvcGVyYXRpb24gaGFzIGl0cyBzY3JvbGxUb1BvcyBwcm9wZXJ0eSBzZXQsIGFuZCBhbm90aGVyXG4gIC8vIHNjcm9sbCBhY3Rpb24gaXMgYXBwbGllZCBiZWZvcmUgdGhlIGVuZCBvZiB0aGUgb3BlcmF0aW9uLCB0aGlzXG4gIC8vICdzaW11bGF0ZXMnIHNjcm9sbGluZyB0aGF0IHBvc2l0aW9uIGludG8gdmlldyBpbiBhIGNoZWFwIHdheSwgc29cbiAgLy8gdGhhdCB0aGUgZWZmZWN0IG9mIGludGVybWVkaWF0ZSBzY3JvbGwgY29tbWFuZHMgaXMgbm90IGlnbm9yZWQuXG4gIGZ1bmN0aW9uIHJlc29sdmVTY3JvbGxUb1BvcyhjbSkge1xuICAgIHZhciByYW5nZSA9IGNtLmN1ck9wLnNjcm9sbFRvUG9zO1xuICAgIGlmIChyYW5nZSkge1xuICAgICAgY20uY3VyT3Auc2Nyb2xsVG9Qb3MgPSBudWxsO1xuICAgICAgdmFyIGZyb20gPSBlc3RpbWF0ZUNvb3JkcyhjbSwgcmFuZ2UuZnJvbSksIHRvID0gZXN0aW1hdGVDb29yZHMoY20sIHJhbmdlLnRvKTtcbiAgICAgIHZhciBzUG9zID0gY2FsY3VsYXRlU2Nyb2xsUG9zKGNtLCBNYXRoLm1pbihmcm9tLmxlZnQsIHRvLmxlZnQpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgTWF0aC5taW4oZnJvbS50b3AsIHRvLnRvcCkgLSByYW5nZS5tYXJnaW4sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBNYXRoLm1heChmcm9tLnJpZ2h0LCB0by5yaWdodCksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBNYXRoLm1heChmcm9tLmJvdHRvbSwgdG8uYm90dG9tKSArIHJhbmdlLm1hcmdpbik7XG4gICAgICBjbS5zY3JvbGxUbyhzUG9zLnNjcm9sbExlZnQsIHNQb3Muc2Nyb2xsVG9wKTtcbiAgICB9XG4gIH1cblxuICAvLyBBUEkgVVRJTElUSUVTXG5cbiAgLy8gSW5kZW50IHRoZSBnaXZlbiBsaW5lLiBUaGUgaG93IHBhcmFtZXRlciBjYW4gYmUgXCJzbWFydFwiLFxuICAvLyBcImFkZFwiL251bGwsIFwic3VidHJhY3RcIiwgb3IgXCJwcmV2XCIuIFdoZW4gYWdncmVzc2l2ZSBpcyBmYWxzZVxuICAvLyAodHlwaWNhbGx5IHNldCB0byB0cnVlIGZvciBmb3JjZWQgc2luZ2xlLWxpbmUgaW5kZW50cyksIGVtcHR5XG4gIC8vIGxpbmVzIGFyZSBub3QgaW5kZW50ZWQsIGFuZCBwbGFjZXMgd2hlcmUgdGhlIG1vZGUgcmV0dXJucyBQYXNzXG4gIC8vIGFyZSBsZWZ0IGFsb25lLlxuICBmdW5jdGlvbiBpbmRlbnRMaW5lKGNtLCBuLCBob3csIGFnZ3Jlc3NpdmUpIHtcbiAgICB2YXIgZG9jID0gY20uZG9jLCBzdGF0ZTtcbiAgICBpZiAoaG93ID09IG51bGwpIGhvdyA9IFwiYWRkXCI7XG4gICAgaWYgKGhvdyA9PSBcInNtYXJ0XCIpIHtcbiAgICAgIC8vIEZhbGwgYmFjayB0byBcInByZXZcIiB3aGVuIHRoZSBtb2RlIGRvZXNuJ3QgaGF2ZSBhbiBpbmRlbnRhdGlvblxuICAgICAgLy8gbWV0aG9kLlxuICAgICAgaWYgKCFkb2MubW9kZS5pbmRlbnQpIGhvdyA9IFwicHJldlwiO1xuICAgICAgZWxzZSBzdGF0ZSA9IGdldFN0YXRlQmVmb3JlKGNtLCBuKTtcbiAgICB9XG5cbiAgICB2YXIgdGFiU2l6ZSA9IGNtLm9wdGlvbnMudGFiU2l6ZTtcbiAgICB2YXIgbGluZSA9IGdldExpbmUoZG9jLCBuKSwgY3VyU3BhY2UgPSBjb3VudENvbHVtbihsaW5lLnRleHQsIG51bGwsIHRhYlNpemUpO1xuICAgIGlmIChsaW5lLnN0YXRlQWZ0ZXIpIGxpbmUuc3RhdGVBZnRlciA9IG51bGw7XG4gICAgdmFyIGN1clNwYWNlU3RyaW5nID0gbGluZS50ZXh0Lm1hdGNoKC9eXFxzKi8pWzBdLCBpbmRlbnRhdGlvbjtcbiAgICBpZiAoIWFnZ3Jlc3NpdmUgJiYgIS9cXFMvLnRlc3QobGluZS50ZXh0KSkge1xuICAgICAgaW5kZW50YXRpb24gPSAwO1xuICAgICAgaG93ID0gXCJub3RcIjtcbiAgICB9IGVsc2UgaWYgKGhvdyA9PSBcInNtYXJ0XCIpIHtcbiAgICAgIGluZGVudGF0aW9uID0gZG9jLm1vZGUuaW5kZW50KHN0YXRlLCBsaW5lLnRleHQuc2xpY2UoY3VyU3BhY2VTdHJpbmcubGVuZ3RoKSwgbGluZS50ZXh0KTtcbiAgICAgIGlmIChpbmRlbnRhdGlvbiA9PSBQYXNzIHx8IGluZGVudGF0aW9uID4gMTUwKSB7XG4gICAgICAgIGlmICghYWdncmVzc2l2ZSkgcmV0dXJuO1xuICAgICAgICBob3cgPSBcInByZXZcIjtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKGhvdyA9PSBcInByZXZcIikge1xuICAgICAgaWYgKG4gPiBkb2MuZmlyc3QpIGluZGVudGF0aW9uID0gY291bnRDb2x1bW4oZ2V0TGluZShkb2MsIG4tMSkudGV4dCwgbnVsbCwgdGFiU2l6ZSk7XG4gICAgICBlbHNlIGluZGVudGF0aW9uID0gMDtcbiAgICB9IGVsc2UgaWYgKGhvdyA9PSBcImFkZFwiKSB7XG4gICAgICBpbmRlbnRhdGlvbiA9IGN1clNwYWNlICsgY20ub3B0aW9ucy5pbmRlbnRVbml0O1xuICAgIH0gZWxzZSBpZiAoaG93ID09IFwic3VidHJhY3RcIikge1xuICAgICAgaW5kZW50YXRpb24gPSBjdXJTcGFjZSAtIGNtLm9wdGlvbnMuaW5kZW50VW5pdDtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBob3cgPT0gXCJudW1iZXJcIikge1xuICAgICAgaW5kZW50YXRpb24gPSBjdXJTcGFjZSArIGhvdztcbiAgICB9XG4gICAgaW5kZW50YXRpb24gPSBNYXRoLm1heCgwLCBpbmRlbnRhdGlvbik7XG5cbiAgICB2YXIgaW5kZW50U3RyaW5nID0gXCJcIiwgcG9zID0gMDtcbiAgICBpZiAoY20ub3B0aW9ucy5pbmRlbnRXaXRoVGFicylcbiAgICAgIGZvciAodmFyIGkgPSBNYXRoLmZsb29yKGluZGVudGF0aW9uIC8gdGFiU2l6ZSk7IGk7IC0taSkge3BvcyArPSB0YWJTaXplOyBpbmRlbnRTdHJpbmcgKz0gXCJcXHRcIjt9XG4gICAgaWYgKHBvcyA8IGluZGVudGF0aW9uKSBpbmRlbnRTdHJpbmcgKz0gc3BhY2VTdHIoaW5kZW50YXRpb24gLSBwb3MpO1xuXG4gICAgaWYgKGluZGVudFN0cmluZyAhPSBjdXJTcGFjZVN0cmluZykge1xuICAgICAgcmVwbGFjZVJhbmdlKGRvYywgaW5kZW50U3RyaW5nLCBQb3MobiwgMCksIFBvcyhuLCBjdXJTcGFjZVN0cmluZy5sZW5ndGgpLCBcIitpbnB1dFwiKTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gRW5zdXJlIHRoYXQsIGlmIHRoZSBjdXJzb3Igd2FzIGluIHRoZSB3aGl0ZXNwYWNlIGF0IHRoZSBzdGFydFxuICAgICAgLy8gb2YgdGhlIGxpbmUsIGl0IGlzIG1vdmVkIHRvIHRoZSBlbmQgb2YgdGhhdCBzcGFjZS5cbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZG9jLnNlbC5yYW5nZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgdmFyIHJhbmdlID0gZG9jLnNlbC5yYW5nZXNbaV07XG4gICAgICAgIGlmIChyYW5nZS5oZWFkLmxpbmUgPT0gbiAmJiByYW5nZS5oZWFkLmNoIDwgY3VyU3BhY2VTdHJpbmcubGVuZ3RoKSB7XG4gICAgICAgICAgdmFyIHBvcyA9IFBvcyhuLCBjdXJTcGFjZVN0cmluZy5sZW5ndGgpO1xuICAgICAgICAgIHJlcGxhY2VPbmVTZWxlY3Rpb24oZG9jLCBpLCBuZXcgUmFuZ2UocG9zLCBwb3MpKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICBsaW5lLnN0YXRlQWZ0ZXIgPSBudWxsO1xuICB9XG5cbiAgLy8gVXRpbGl0eSBmb3IgYXBwbHlpbmcgYSBjaGFuZ2UgdG8gYSBsaW5lIGJ5IGhhbmRsZSBvciBudW1iZXIsXG4gIC8vIHJldHVybmluZyB0aGUgbnVtYmVyIGFuZCBvcHRpb25hbGx5IHJlZ2lzdGVyaW5nIHRoZSBsaW5lIGFzXG4gIC8vIGNoYW5nZWQuXG4gIGZ1bmN0aW9uIGNoYW5nZUxpbmUoZG9jLCBoYW5kbGUsIGNoYW5nZVR5cGUsIG9wKSB7XG4gICAgdmFyIG5vID0gaGFuZGxlLCBsaW5lID0gaGFuZGxlO1xuICAgIGlmICh0eXBlb2YgaGFuZGxlID09IFwibnVtYmVyXCIpIGxpbmUgPSBnZXRMaW5lKGRvYywgY2xpcExpbmUoZG9jLCBoYW5kbGUpKTtcbiAgICBlbHNlIG5vID0gbGluZU5vKGhhbmRsZSk7XG4gICAgaWYgKG5vID09IG51bGwpIHJldHVybiBudWxsO1xuICAgIGlmIChvcChsaW5lLCBubykgJiYgZG9jLmNtKSByZWdMaW5lQ2hhbmdlKGRvYy5jbSwgbm8sIGNoYW5nZVR5cGUpO1xuICAgIHJldHVybiBsaW5lO1xuICB9XG5cbiAgLy8gSGVscGVyIGZvciBkZWxldGluZyB0ZXh0IG5lYXIgdGhlIHNlbGVjdGlvbihzKSwgdXNlZCB0byBpbXBsZW1lbnRcbiAgLy8gYmFja3NwYWNlLCBkZWxldGUsIGFuZCBzaW1pbGFyIGZ1bmN0aW9uYWxpdHkuXG4gIGZ1bmN0aW9uIGRlbGV0ZU5lYXJTZWxlY3Rpb24oY20sIGNvbXB1dGUpIHtcbiAgICB2YXIgcmFuZ2VzID0gY20uZG9jLnNlbC5yYW5nZXMsIGtpbGwgPSBbXTtcbiAgICAvLyBCdWlsZCB1cCBhIHNldCBvZiByYW5nZXMgdG8ga2lsbCBmaXJzdCwgbWVyZ2luZyBvdmVybGFwcGluZ1xuICAgIC8vIHJhbmdlcy5cbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHJhbmdlcy5sZW5ndGg7IGkrKykge1xuICAgICAgdmFyIHRvS2lsbCA9IGNvbXB1dGUocmFuZ2VzW2ldKTtcbiAgICAgIHdoaWxlIChraWxsLmxlbmd0aCAmJiBjbXAodG9LaWxsLmZyb20sIGxzdChraWxsKS50bykgPD0gMCkge1xuICAgICAgICB2YXIgcmVwbGFjZWQgPSBraWxsLnBvcCgpO1xuICAgICAgICBpZiAoY21wKHJlcGxhY2VkLmZyb20sIHRvS2lsbC5mcm9tKSA8IDApIHtcbiAgICAgICAgICB0b0tpbGwuZnJvbSA9IHJlcGxhY2VkLmZyb207XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGtpbGwucHVzaCh0b0tpbGwpO1xuICAgIH1cbiAgICAvLyBOZXh0LCByZW1vdmUgdGhvc2UgYWN0dWFsIHJhbmdlcy5cbiAgICBydW5Jbk9wKGNtLCBmdW5jdGlvbigpIHtcbiAgICAgIGZvciAodmFyIGkgPSBraWxsLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKVxuICAgICAgICByZXBsYWNlUmFuZ2UoY20uZG9jLCBcIlwiLCBraWxsW2ldLmZyb20sIGtpbGxbaV0udG8sIFwiK2RlbGV0ZVwiKTtcbiAgICAgIGVuc3VyZUN1cnNvclZpc2libGUoY20pO1xuICAgIH0pO1xuICB9XG5cbiAgLy8gVXNlZCBmb3IgaG9yaXpvbnRhbCByZWxhdGl2ZSBtb3Rpb24uIERpciBpcyAtMSBvciAxIChsZWZ0IG9yXG4gIC8vIHJpZ2h0KSwgdW5pdCBjYW4gYmUgXCJjaGFyXCIsIFwiY29sdW1uXCIgKGxpa2UgY2hhciwgYnV0IGRvZXNuJ3RcbiAgLy8gY3Jvc3MgbGluZSBib3VuZGFyaWVzKSwgXCJ3b3JkXCIgKGFjcm9zcyBuZXh0IHdvcmQpLCBvciBcImdyb3VwXCIgKHRvXG4gIC8vIHRoZSBzdGFydCBvZiBuZXh0IGdyb3VwIG9mIHdvcmQgb3Igbm9uLXdvcmQtbm9uLXdoaXRlc3BhY2VcbiAgLy8gY2hhcnMpLiBUaGUgdmlzdWFsbHkgcGFyYW0gY29udHJvbHMgd2hldGhlciwgaW4gcmlnaHQtdG8tbGVmdFxuICAvLyB0ZXh0LCBkaXJlY3Rpb24gMSBtZWFucyB0byBtb3ZlIHRvd2FyZHMgdGhlIG5leHQgaW5kZXggaW4gdGhlXG4gIC8vIHN0cmluZywgb3IgdG93YXJkcyB0aGUgY2hhcmFjdGVyIHRvIHRoZSByaWdodCBvZiB0aGUgY3VycmVudFxuICAvLyBwb3NpdGlvbi4gVGhlIHJlc3VsdGluZyBwb3NpdGlvbiB3aWxsIGhhdmUgYSBoaXRTaWRlPXRydWVcbiAgLy8gcHJvcGVydHkgaWYgaXQgcmVhY2hlZCB0aGUgZW5kIG9mIHRoZSBkb2N1bWVudC5cbiAgZnVuY3Rpb24gZmluZFBvc0goZG9jLCBwb3MsIGRpciwgdW5pdCwgdmlzdWFsbHkpIHtcbiAgICB2YXIgbGluZSA9IHBvcy5saW5lLCBjaCA9IHBvcy5jaCwgb3JpZ0RpciA9IGRpcjtcbiAgICB2YXIgbGluZU9iaiA9IGdldExpbmUoZG9jLCBsaW5lKTtcbiAgICB2YXIgcG9zc2libGUgPSB0cnVlO1xuICAgIGZ1bmN0aW9uIGZpbmROZXh0TGluZSgpIHtcbiAgICAgIHZhciBsID0gbGluZSArIGRpcjtcbiAgICAgIGlmIChsIDwgZG9jLmZpcnN0IHx8IGwgPj0gZG9jLmZpcnN0ICsgZG9jLnNpemUpIHJldHVybiAocG9zc2libGUgPSBmYWxzZSk7XG4gICAgICBsaW5lID0gbDtcbiAgICAgIHJldHVybiBsaW5lT2JqID0gZ2V0TGluZShkb2MsIGwpO1xuICAgIH1cbiAgICBmdW5jdGlvbiBtb3ZlT25jZShib3VuZFRvTGluZSkge1xuICAgICAgdmFyIG5leHQgPSAodmlzdWFsbHkgPyBtb3ZlVmlzdWFsbHkgOiBtb3ZlTG9naWNhbGx5KShsaW5lT2JqLCBjaCwgZGlyLCB0cnVlKTtcbiAgICAgIGlmIChuZXh0ID09IG51bGwpIHtcbiAgICAgICAgaWYgKCFib3VuZFRvTGluZSAmJiBmaW5kTmV4dExpbmUoKSkge1xuICAgICAgICAgIGlmICh2aXN1YWxseSkgY2ggPSAoZGlyIDwgMCA/IGxpbmVSaWdodCA6IGxpbmVMZWZ0KShsaW5lT2JqKTtcbiAgICAgICAgICBlbHNlIGNoID0gZGlyIDwgMCA/IGxpbmVPYmoudGV4dC5sZW5ndGggOiAwO1xuICAgICAgICB9IGVsc2UgcmV0dXJuIChwb3NzaWJsZSA9IGZhbHNlKTtcbiAgICAgIH0gZWxzZSBjaCA9IG5leHQ7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBpZiAodW5pdCA9PSBcImNoYXJcIikgbW92ZU9uY2UoKTtcbiAgICBlbHNlIGlmICh1bml0ID09IFwiY29sdW1uXCIpIG1vdmVPbmNlKHRydWUpO1xuICAgIGVsc2UgaWYgKHVuaXQgPT0gXCJ3b3JkXCIgfHwgdW5pdCA9PSBcImdyb3VwXCIpIHtcbiAgICAgIHZhciBzYXdUeXBlID0gbnVsbCwgZ3JvdXAgPSB1bml0ID09IFwiZ3JvdXBcIjtcbiAgICAgIHZhciBoZWxwZXIgPSBkb2MuY20gJiYgZG9jLmNtLmdldEhlbHBlcihwb3MsIFwid29yZENoYXJzXCIpO1xuICAgICAgZm9yICh2YXIgZmlyc3QgPSB0cnVlOzsgZmlyc3QgPSBmYWxzZSkge1xuICAgICAgICBpZiAoZGlyIDwgMCAmJiAhbW92ZU9uY2UoIWZpcnN0KSkgYnJlYWs7XG4gICAgICAgIHZhciBjdXIgPSBsaW5lT2JqLnRleHQuY2hhckF0KGNoKSB8fCBcIlxcblwiO1xuICAgICAgICB2YXIgdHlwZSA9IGlzV29yZENoYXIoY3VyLCBoZWxwZXIpID8gXCJ3XCJcbiAgICAgICAgICA6IGdyb3VwICYmIGN1ciA9PSBcIlxcblwiID8gXCJuXCJcbiAgICAgICAgICA6ICFncm91cCB8fCAvXFxzLy50ZXN0KGN1cikgPyBudWxsXG4gICAgICAgICAgOiBcInBcIjtcbiAgICAgICAgaWYgKGdyb3VwICYmICFmaXJzdCAmJiAhdHlwZSkgdHlwZSA9IFwic1wiO1xuICAgICAgICBpZiAoc2F3VHlwZSAmJiBzYXdUeXBlICE9IHR5cGUpIHtcbiAgICAgICAgICBpZiAoZGlyIDwgMCkge2RpciA9IDE7IG1vdmVPbmNlKCk7fVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHR5cGUpIHNhd1R5cGUgPSB0eXBlO1xuICAgICAgICBpZiAoZGlyID4gMCAmJiAhbW92ZU9uY2UoIWZpcnN0KSkgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICAgIHZhciByZXN1bHQgPSBza2lwQXRvbWljKGRvYywgUG9zKGxpbmUsIGNoKSwgb3JpZ0RpciwgdHJ1ZSk7XG4gICAgaWYgKCFwb3NzaWJsZSkgcmVzdWx0LmhpdFNpZGUgPSB0cnVlO1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICAvLyBGb3IgcmVsYXRpdmUgdmVydGljYWwgbW92ZW1lbnQuIERpciBtYXkgYmUgLTEgb3IgMS4gVW5pdCBjYW4gYmVcbiAgLy8gXCJwYWdlXCIgb3IgXCJsaW5lXCIuIFRoZSByZXN1bHRpbmcgcG9zaXRpb24gd2lsbCBoYXZlIGEgaGl0U2lkZT10cnVlXG4gIC8vIHByb3BlcnR5IGlmIGl0IHJlYWNoZWQgdGhlIGVuZCBvZiB0aGUgZG9jdW1lbnQuXG4gIGZ1bmN0aW9uIGZpbmRQb3NWKGNtLCBwb3MsIGRpciwgdW5pdCkge1xuICAgIHZhciBkb2MgPSBjbS5kb2MsIHggPSBwb3MubGVmdCwgeTtcbiAgICBpZiAodW5pdCA9PSBcInBhZ2VcIikge1xuICAgICAgdmFyIHBhZ2VTaXplID0gTWF0aC5taW4oY20uZGlzcGxheS53cmFwcGVyLmNsaWVudEhlaWdodCwgd2luZG93LmlubmVySGVpZ2h0IHx8IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5jbGllbnRIZWlnaHQpO1xuICAgICAgeSA9IHBvcy50b3AgKyBkaXIgKiAocGFnZVNpemUgLSAoZGlyIDwgMCA/IDEuNSA6IC41KSAqIHRleHRIZWlnaHQoY20uZGlzcGxheSkpO1xuICAgIH0gZWxzZSBpZiAodW5pdCA9PSBcImxpbmVcIikge1xuICAgICAgeSA9IGRpciA+IDAgPyBwb3MuYm90dG9tICsgMyA6IHBvcy50b3AgLSAzO1xuICAgIH1cbiAgICBmb3IgKDs7KSB7XG4gICAgICB2YXIgdGFyZ2V0ID0gY29vcmRzQ2hhcihjbSwgeCwgeSk7XG4gICAgICBpZiAoIXRhcmdldC5vdXRzaWRlKSBicmVhaztcbiAgICAgIGlmIChkaXIgPCAwID8geSA8PSAwIDogeSA+PSBkb2MuaGVpZ2h0KSB7IHRhcmdldC5oaXRTaWRlID0gdHJ1ZTsgYnJlYWs7IH1cbiAgICAgIHkgKz0gZGlyICogNTtcbiAgICB9XG4gICAgcmV0dXJuIHRhcmdldDtcbiAgfVxuXG4gIC8vIEZpbmQgdGhlIHdvcmQgYXQgdGhlIGdpdmVuIHBvc2l0aW9uIChhcyByZXR1cm5lZCBieSBjb29yZHNDaGFyKS5cbiAgZnVuY3Rpb24gZmluZFdvcmRBdChjbSwgcG9zKSB7XG4gICAgdmFyIGRvYyA9IGNtLmRvYywgbGluZSA9IGdldExpbmUoZG9jLCBwb3MubGluZSkudGV4dDtcbiAgICB2YXIgc3RhcnQgPSBwb3MuY2gsIGVuZCA9IHBvcy5jaDtcbiAgICBpZiAobGluZSkge1xuICAgICAgdmFyIGhlbHBlciA9IGNtLmdldEhlbHBlcihwb3MsIFwid29yZENoYXJzXCIpO1xuICAgICAgaWYgKChwb3MueFJlbCA8IDAgfHwgZW5kID09IGxpbmUubGVuZ3RoKSAmJiBzdGFydCkgLS1zdGFydDsgZWxzZSArK2VuZDtcbiAgICAgIHZhciBzdGFydENoYXIgPSBsaW5lLmNoYXJBdChzdGFydCk7XG4gICAgICB2YXIgY2hlY2sgPSBpc1dvcmRDaGFyKHN0YXJ0Q2hhciwgaGVscGVyKVxuICAgICAgICA/IGZ1bmN0aW9uKGNoKSB7IHJldHVybiBpc1dvcmRDaGFyKGNoLCBoZWxwZXIpOyB9XG4gICAgICAgIDogL1xccy8udGVzdChzdGFydENoYXIpID8gZnVuY3Rpb24oY2gpIHtyZXR1cm4gL1xccy8udGVzdChjaCk7fVxuICAgICAgICA6IGZ1bmN0aW9uKGNoKSB7cmV0dXJuICEvXFxzLy50ZXN0KGNoKSAmJiAhaXNXb3JkQ2hhcihjaCk7fTtcbiAgICAgIHdoaWxlIChzdGFydCA+IDAgJiYgY2hlY2sobGluZS5jaGFyQXQoc3RhcnQgLSAxKSkpIC0tc3RhcnQ7XG4gICAgICB3aGlsZSAoZW5kIDwgbGluZS5sZW5ndGggJiYgY2hlY2sobGluZS5jaGFyQXQoZW5kKSkpICsrZW5kO1xuICAgIH1cbiAgICByZXR1cm4gbmV3IFJhbmdlKFBvcyhwb3MubGluZSwgc3RhcnQpLCBQb3MocG9zLmxpbmUsIGVuZCkpO1xuICB9XG5cbiAgLy8gRURJVE9SIE1FVEhPRFNcblxuICAvLyBUaGUgcHVibGljbHkgdmlzaWJsZSBBUEkuIE5vdGUgdGhhdCBtZXRob2RPcChmKSBtZWFuc1xuICAvLyAnd3JhcCBmIGluIGFuIG9wZXJhdGlvbiwgcGVyZm9ybWVkIG9uIGl0cyBgdGhpc2AgcGFyYW1ldGVyJy5cblxuICAvLyBUaGlzIGlzIG5vdCB0aGUgY29tcGxldGUgc2V0IG9mIGVkaXRvciBtZXRob2RzLiBNb3N0IG9mIHRoZVxuICAvLyBtZXRob2RzIGRlZmluZWQgb24gdGhlIERvYyB0eXBlIGFyZSBhbHNvIGluamVjdGVkIGludG9cbiAgLy8gQ29kZU1pcnJvci5wcm90b3R5cGUsIGZvciBiYWNrd2FyZHMgY29tcGF0aWJpbGl0eSBhbmRcbiAgLy8gY29udmVuaWVuY2UuXG5cbiAgQ29kZU1pcnJvci5wcm90b3R5cGUgPSB7XG4gICAgY29uc3RydWN0b3I6IENvZGVNaXJyb3IsXG4gICAgZm9jdXM6IGZ1bmN0aW9uKCl7d2luZG93LmZvY3VzKCk7IGZvY3VzSW5wdXQodGhpcyk7IGZhc3RQb2xsKHRoaXMpO30sXG5cbiAgICBzZXRPcHRpb246IGZ1bmN0aW9uKG9wdGlvbiwgdmFsdWUpIHtcbiAgICAgIHZhciBvcHRpb25zID0gdGhpcy5vcHRpb25zLCBvbGQgPSBvcHRpb25zW29wdGlvbl07XG4gICAgICBpZiAob3B0aW9uc1tvcHRpb25dID09IHZhbHVlICYmIG9wdGlvbiAhPSBcIm1vZGVcIikgcmV0dXJuO1xuICAgICAgb3B0aW9uc1tvcHRpb25dID0gdmFsdWU7XG4gICAgICBpZiAob3B0aW9uSGFuZGxlcnMuaGFzT3duUHJvcGVydHkob3B0aW9uKSlcbiAgICAgICAgb3BlcmF0aW9uKHRoaXMsIG9wdGlvbkhhbmRsZXJzW29wdGlvbl0pKHRoaXMsIHZhbHVlLCBvbGQpO1xuICAgIH0sXG5cbiAgICBnZXRPcHRpb246IGZ1bmN0aW9uKG9wdGlvbikge3JldHVybiB0aGlzLm9wdGlvbnNbb3B0aW9uXTt9LFxuICAgIGdldERvYzogZnVuY3Rpb24oKSB7cmV0dXJuIHRoaXMuZG9jO30sXG5cbiAgICBhZGRLZXlNYXA6IGZ1bmN0aW9uKG1hcCwgYm90dG9tKSB7XG4gICAgICB0aGlzLnN0YXRlLmtleU1hcHNbYm90dG9tID8gXCJwdXNoXCIgOiBcInVuc2hpZnRcIl0obWFwKTtcbiAgICB9LFxuICAgIHJlbW92ZUtleU1hcDogZnVuY3Rpb24obWFwKSB7XG4gICAgICB2YXIgbWFwcyA9IHRoaXMuc3RhdGUua2V5TWFwcztcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbWFwcy5sZW5ndGg7ICsraSlcbiAgICAgICAgaWYgKG1hcHNbaV0gPT0gbWFwIHx8ICh0eXBlb2YgbWFwc1tpXSAhPSBcInN0cmluZ1wiICYmIG1hcHNbaV0ubmFtZSA9PSBtYXApKSB7XG4gICAgICAgICAgbWFwcy5zcGxpY2UoaSwgMSk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgYWRkT3ZlcmxheTogbWV0aG9kT3AoZnVuY3Rpb24oc3BlYywgb3B0aW9ucykge1xuICAgICAgdmFyIG1vZGUgPSBzcGVjLnRva2VuID8gc3BlYyA6IENvZGVNaXJyb3IuZ2V0TW9kZSh0aGlzLm9wdGlvbnMsIHNwZWMpO1xuICAgICAgaWYgKG1vZGUuc3RhcnRTdGF0ZSkgdGhyb3cgbmV3IEVycm9yKFwiT3ZlcmxheXMgbWF5IG5vdCBiZSBzdGF0ZWZ1bC5cIik7XG4gICAgICB0aGlzLnN0YXRlLm92ZXJsYXlzLnB1c2goe21vZGU6IG1vZGUsIG1vZGVTcGVjOiBzcGVjLCBvcGFxdWU6IG9wdGlvbnMgJiYgb3B0aW9ucy5vcGFxdWV9KTtcbiAgICAgIHRoaXMuc3RhdGUubW9kZUdlbisrO1xuICAgICAgcmVnQ2hhbmdlKHRoaXMpO1xuICAgIH0pLFxuICAgIHJlbW92ZU92ZXJsYXk6IG1ldGhvZE9wKGZ1bmN0aW9uKHNwZWMpIHtcbiAgICAgIHZhciBvdmVybGF5cyA9IHRoaXMuc3RhdGUub3ZlcmxheXM7XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IG92ZXJsYXlzLmxlbmd0aDsgKytpKSB7XG4gICAgICAgIHZhciBjdXIgPSBvdmVybGF5c1tpXS5tb2RlU3BlYztcbiAgICAgICAgaWYgKGN1ciA9PSBzcGVjIHx8IHR5cGVvZiBzcGVjID09IFwic3RyaW5nXCIgJiYgY3VyLm5hbWUgPT0gc3BlYykge1xuICAgICAgICAgIG92ZXJsYXlzLnNwbGljZShpLCAxKTtcbiAgICAgICAgICB0aGlzLnN0YXRlLm1vZGVHZW4rKztcbiAgICAgICAgICByZWdDaGFuZ2UodGhpcyk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSksXG5cbiAgICBpbmRlbnRMaW5lOiBtZXRob2RPcChmdW5jdGlvbihuLCBkaXIsIGFnZ3Jlc3NpdmUpIHtcbiAgICAgIGlmICh0eXBlb2YgZGlyICE9IFwic3RyaW5nXCIgJiYgdHlwZW9mIGRpciAhPSBcIm51bWJlclwiKSB7XG4gICAgICAgIGlmIChkaXIgPT0gbnVsbCkgZGlyID0gdGhpcy5vcHRpb25zLnNtYXJ0SW5kZW50ID8gXCJzbWFydFwiIDogXCJwcmV2XCI7XG4gICAgICAgIGVsc2UgZGlyID0gZGlyID8gXCJhZGRcIiA6IFwic3VidHJhY3RcIjtcbiAgICAgIH1cbiAgICAgIGlmIChpc0xpbmUodGhpcy5kb2MsIG4pKSBpbmRlbnRMaW5lKHRoaXMsIG4sIGRpciwgYWdncmVzc2l2ZSk7XG4gICAgfSksXG4gICAgaW5kZW50U2VsZWN0aW9uOiBtZXRob2RPcChmdW5jdGlvbihob3cpIHtcbiAgICAgIHZhciByYW5nZXMgPSB0aGlzLmRvYy5zZWwucmFuZ2VzLCBlbmQgPSAtMTtcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgcmFuZ2VzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIHZhciByYW5nZSA9IHJhbmdlc1tpXTtcbiAgICAgICAgaWYgKCFyYW5nZS5lbXB0eSgpKSB7XG4gICAgICAgICAgdmFyIHN0YXJ0ID0gTWF0aC5tYXgoZW5kLCByYW5nZS5mcm9tKCkubGluZSk7XG4gICAgICAgICAgdmFyIHRvID0gcmFuZ2UudG8oKTtcbiAgICAgICAgICBlbmQgPSBNYXRoLm1pbih0aGlzLmxhc3RMaW5lKCksIHRvLmxpbmUgLSAodG8uY2ggPyAwIDogMSkpICsgMTtcbiAgICAgICAgICBmb3IgKHZhciBqID0gc3RhcnQ7IGogPCBlbmQ7ICsrailcbiAgICAgICAgICAgIGluZGVudExpbmUodGhpcywgaiwgaG93KTtcbiAgICAgICAgfSBlbHNlIGlmIChyYW5nZS5oZWFkLmxpbmUgPiBlbmQpIHtcbiAgICAgICAgICBpbmRlbnRMaW5lKHRoaXMsIHJhbmdlLmhlYWQubGluZSwgaG93LCB0cnVlKTtcbiAgICAgICAgICBlbmQgPSByYW5nZS5oZWFkLmxpbmU7XG4gICAgICAgICAgaWYgKGkgPT0gdGhpcy5kb2Muc2VsLnByaW1JbmRleCkgZW5zdXJlQ3Vyc29yVmlzaWJsZSh0aGlzKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0pLFxuXG4gICAgLy8gRmV0Y2ggdGhlIHBhcnNlciB0b2tlbiBmb3IgYSBnaXZlbiBjaGFyYWN0ZXIuIFVzZWZ1bCBmb3IgaGFja3NcbiAgICAvLyB0aGF0IHdhbnQgdG8gaW5zcGVjdCB0aGUgbW9kZSBzdGF0ZSAoc2F5LCBmb3IgY29tcGxldGlvbikuXG4gICAgZ2V0VG9rZW5BdDogZnVuY3Rpb24ocG9zLCBwcmVjaXNlKSB7XG4gICAgICB2YXIgZG9jID0gdGhpcy5kb2M7XG4gICAgICBwb3MgPSBjbGlwUG9zKGRvYywgcG9zKTtcbiAgICAgIHZhciBzdGF0ZSA9IGdldFN0YXRlQmVmb3JlKHRoaXMsIHBvcy5saW5lLCBwcmVjaXNlKSwgbW9kZSA9IHRoaXMuZG9jLm1vZGU7XG4gICAgICB2YXIgbGluZSA9IGdldExpbmUoZG9jLCBwb3MubGluZSk7XG4gICAgICB2YXIgc3RyZWFtID0gbmV3IFN0cmluZ1N0cmVhbShsaW5lLnRleHQsIHRoaXMub3B0aW9ucy50YWJTaXplKTtcbiAgICAgIHdoaWxlIChzdHJlYW0ucG9zIDwgcG9zLmNoICYmICFzdHJlYW0uZW9sKCkpIHtcbiAgICAgICAgc3RyZWFtLnN0YXJ0ID0gc3RyZWFtLnBvcztcbiAgICAgICAgdmFyIHN0eWxlID0gcmVhZFRva2VuKG1vZGUsIHN0cmVhbSwgc3RhdGUpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHtzdGFydDogc3RyZWFtLnN0YXJ0LFxuICAgICAgICAgICAgICBlbmQ6IHN0cmVhbS5wb3MsXG4gICAgICAgICAgICAgIHN0cmluZzogc3RyZWFtLmN1cnJlbnQoKSxcbiAgICAgICAgICAgICAgdHlwZTogc3R5bGUgfHwgbnVsbCxcbiAgICAgICAgICAgICAgc3RhdGU6IHN0YXRlfTtcbiAgICB9LFxuXG4gICAgZ2V0VG9rZW5UeXBlQXQ6IGZ1bmN0aW9uKHBvcykge1xuICAgICAgcG9zID0gY2xpcFBvcyh0aGlzLmRvYywgcG9zKTtcbiAgICAgIHZhciBzdHlsZXMgPSBnZXRMaW5lU3R5bGVzKHRoaXMsIGdldExpbmUodGhpcy5kb2MsIHBvcy5saW5lKSk7XG4gICAgICB2YXIgYmVmb3JlID0gMCwgYWZ0ZXIgPSAoc3R5bGVzLmxlbmd0aCAtIDEpIC8gMiwgY2ggPSBwb3MuY2g7XG4gICAgICB2YXIgdHlwZTtcbiAgICAgIGlmIChjaCA9PSAwKSB0eXBlID0gc3R5bGVzWzJdO1xuICAgICAgZWxzZSBmb3IgKDs7KSB7XG4gICAgICAgIHZhciBtaWQgPSAoYmVmb3JlICsgYWZ0ZXIpID4+IDE7XG4gICAgICAgIGlmICgobWlkID8gc3R5bGVzW21pZCAqIDIgLSAxXSA6IDApID49IGNoKSBhZnRlciA9IG1pZDtcbiAgICAgICAgZWxzZSBpZiAoc3R5bGVzW21pZCAqIDIgKyAxXSA8IGNoKSBiZWZvcmUgPSBtaWQgKyAxO1xuICAgICAgICBlbHNlIHsgdHlwZSA9IHN0eWxlc1ttaWQgKiAyICsgMl07IGJyZWFrOyB9XG4gICAgICB9XG4gICAgICB2YXIgY3V0ID0gdHlwZSA/IHR5cGUuaW5kZXhPZihcImNtLW92ZXJsYXkgXCIpIDogLTE7XG4gICAgICByZXR1cm4gY3V0IDwgMCA/IHR5cGUgOiBjdXQgPT0gMCA/IG51bGwgOiB0eXBlLnNsaWNlKDAsIGN1dCAtIDEpO1xuICAgIH0sXG5cbiAgICBnZXRNb2RlQXQ6IGZ1bmN0aW9uKHBvcykge1xuICAgICAgdmFyIG1vZGUgPSB0aGlzLmRvYy5tb2RlO1xuICAgICAgaWYgKCFtb2RlLmlubmVyTW9kZSkgcmV0dXJuIG1vZGU7XG4gICAgICByZXR1cm4gQ29kZU1pcnJvci5pbm5lck1vZGUobW9kZSwgdGhpcy5nZXRUb2tlbkF0KHBvcykuc3RhdGUpLm1vZGU7XG4gICAgfSxcblxuICAgIGdldEhlbHBlcjogZnVuY3Rpb24ocG9zLCB0eXBlKSB7XG4gICAgICByZXR1cm4gdGhpcy5nZXRIZWxwZXJzKHBvcywgdHlwZSlbMF07XG4gICAgfSxcblxuICAgIGdldEhlbHBlcnM6IGZ1bmN0aW9uKHBvcywgdHlwZSkge1xuICAgICAgdmFyIGZvdW5kID0gW107XG4gICAgICBpZiAoIWhlbHBlcnMuaGFzT3duUHJvcGVydHkodHlwZSkpIHJldHVybiBoZWxwZXJzO1xuICAgICAgdmFyIGhlbHAgPSBoZWxwZXJzW3R5cGVdLCBtb2RlID0gdGhpcy5nZXRNb2RlQXQocG9zKTtcbiAgICAgIGlmICh0eXBlb2YgbW9kZVt0eXBlXSA9PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIGlmIChoZWxwW21vZGVbdHlwZV1dKSBmb3VuZC5wdXNoKGhlbHBbbW9kZVt0eXBlXV0pO1xuICAgICAgfSBlbHNlIGlmIChtb2RlW3R5cGVdKSB7XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbW9kZVt0eXBlXS5sZW5ndGg7IGkrKykge1xuICAgICAgICAgIHZhciB2YWwgPSBoZWxwW21vZGVbdHlwZV1baV1dO1xuICAgICAgICAgIGlmICh2YWwpIGZvdW5kLnB1c2godmFsKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChtb2RlLmhlbHBlclR5cGUgJiYgaGVscFttb2RlLmhlbHBlclR5cGVdKSB7XG4gICAgICAgIGZvdW5kLnB1c2goaGVscFttb2RlLmhlbHBlclR5cGVdKTtcbiAgICAgIH0gZWxzZSBpZiAoaGVscFttb2RlLm5hbWVdKSB7XG4gICAgICAgIGZvdW5kLnB1c2goaGVscFttb2RlLm5hbWVdKTtcbiAgICAgIH1cbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgaGVscC5fZ2xvYmFsLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIHZhciBjdXIgPSBoZWxwLl9nbG9iYWxbaV07XG4gICAgICAgIGlmIChjdXIucHJlZChtb2RlLCB0aGlzKSAmJiBpbmRleE9mKGZvdW5kLCBjdXIudmFsKSA9PSAtMSlcbiAgICAgICAgICBmb3VuZC5wdXNoKGN1ci52YWwpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGZvdW5kO1xuICAgIH0sXG5cbiAgICBnZXRTdGF0ZUFmdGVyOiBmdW5jdGlvbihsaW5lLCBwcmVjaXNlKSB7XG4gICAgICB2YXIgZG9jID0gdGhpcy5kb2M7XG4gICAgICBsaW5lID0gY2xpcExpbmUoZG9jLCBsaW5lID09IG51bGwgPyBkb2MuZmlyc3QgKyBkb2Muc2l6ZSAtIDE6IGxpbmUpO1xuICAgICAgcmV0dXJuIGdldFN0YXRlQmVmb3JlKHRoaXMsIGxpbmUgKyAxLCBwcmVjaXNlKTtcbiAgICB9LFxuXG4gICAgY3Vyc29yQ29vcmRzOiBmdW5jdGlvbihzdGFydCwgbW9kZSkge1xuICAgICAgdmFyIHBvcywgcmFuZ2UgPSB0aGlzLmRvYy5zZWwucHJpbWFyeSgpO1xuICAgICAgaWYgKHN0YXJ0ID09IG51bGwpIHBvcyA9IHJhbmdlLmhlYWQ7XG4gICAgICBlbHNlIGlmICh0eXBlb2Ygc3RhcnQgPT0gXCJvYmplY3RcIikgcG9zID0gY2xpcFBvcyh0aGlzLmRvYywgc3RhcnQpO1xuICAgICAgZWxzZSBwb3MgPSBzdGFydCA/IHJhbmdlLmZyb20oKSA6IHJhbmdlLnRvKCk7XG4gICAgICByZXR1cm4gY3Vyc29yQ29vcmRzKHRoaXMsIHBvcywgbW9kZSB8fCBcInBhZ2VcIik7XG4gICAgfSxcblxuICAgIGNoYXJDb29yZHM6IGZ1bmN0aW9uKHBvcywgbW9kZSkge1xuICAgICAgcmV0dXJuIGNoYXJDb29yZHModGhpcywgY2xpcFBvcyh0aGlzLmRvYywgcG9zKSwgbW9kZSB8fCBcInBhZ2VcIik7XG4gICAgfSxcblxuICAgIGNvb3Jkc0NoYXI6IGZ1bmN0aW9uKGNvb3JkcywgbW9kZSkge1xuICAgICAgY29vcmRzID0gZnJvbUNvb3JkU3lzdGVtKHRoaXMsIGNvb3JkcywgbW9kZSB8fCBcInBhZ2VcIik7XG4gICAgICByZXR1cm4gY29vcmRzQ2hhcih0aGlzLCBjb29yZHMubGVmdCwgY29vcmRzLnRvcCk7XG4gICAgfSxcblxuICAgIGxpbmVBdEhlaWdodDogZnVuY3Rpb24oaGVpZ2h0LCBtb2RlKSB7XG4gICAgICBoZWlnaHQgPSBmcm9tQ29vcmRTeXN0ZW0odGhpcywge3RvcDogaGVpZ2h0LCBsZWZ0OiAwfSwgbW9kZSB8fCBcInBhZ2VcIikudG9wO1xuICAgICAgcmV0dXJuIGxpbmVBdEhlaWdodCh0aGlzLmRvYywgaGVpZ2h0ICsgdGhpcy5kaXNwbGF5LnZpZXdPZmZzZXQpO1xuICAgIH0sXG4gICAgaGVpZ2h0QXRMaW5lOiBmdW5jdGlvbihsaW5lLCBtb2RlKSB7XG4gICAgICB2YXIgZW5kID0gZmFsc2UsIGxhc3QgPSB0aGlzLmRvYy5maXJzdCArIHRoaXMuZG9jLnNpemUgLSAxO1xuICAgICAgaWYgKGxpbmUgPCB0aGlzLmRvYy5maXJzdCkgbGluZSA9IHRoaXMuZG9jLmZpcnN0O1xuICAgICAgZWxzZSBpZiAobGluZSA+IGxhc3QpIHsgbGluZSA9IGxhc3Q7IGVuZCA9IHRydWU7IH1cbiAgICAgIHZhciBsaW5lT2JqID0gZ2V0TGluZSh0aGlzLmRvYywgbGluZSk7XG4gICAgICByZXR1cm4gaW50b0Nvb3JkU3lzdGVtKHRoaXMsIGxpbmVPYmosIHt0b3A6IDAsIGxlZnQ6IDB9LCBtb2RlIHx8IFwicGFnZVwiKS50b3AgK1xuICAgICAgICAoZW5kID8gdGhpcy5kb2MuaGVpZ2h0IC0gaGVpZ2h0QXRMaW5lKGxpbmVPYmopIDogMCk7XG4gICAgfSxcblxuICAgIGRlZmF1bHRUZXh0SGVpZ2h0OiBmdW5jdGlvbigpIHsgcmV0dXJuIHRleHRIZWlnaHQodGhpcy5kaXNwbGF5KTsgfSxcbiAgICBkZWZhdWx0Q2hhcldpZHRoOiBmdW5jdGlvbigpIHsgcmV0dXJuIGNoYXJXaWR0aCh0aGlzLmRpc3BsYXkpOyB9LFxuXG4gICAgc2V0R3V0dGVyTWFya2VyOiBtZXRob2RPcChmdW5jdGlvbihsaW5lLCBndXR0ZXJJRCwgdmFsdWUpIHtcbiAgICAgIHJldHVybiBjaGFuZ2VMaW5lKHRoaXMuZG9jLCBsaW5lLCBcImd1dHRlclwiLCBmdW5jdGlvbihsaW5lKSB7XG4gICAgICAgIHZhciBtYXJrZXJzID0gbGluZS5ndXR0ZXJNYXJrZXJzIHx8IChsaW5lLmd1dHRlck1hcmtlcnMgPSB7fSk7XG4gICAgICAgIG1hcmtlcnNbZ3V0dGVySURdID0gdmFsdWU7XG4gICAgICAgIGlmICghdmFsdWUgJiYgaXNFbXB0eShtYXJrZXJzKSkgbGluZS5ndXR0ZXJNYXJrZXJzID0gbnVsbDtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9KTtcbiAgICB9KSxcblxuICAgIGNsZWFyR3V0dGVyOiBtZXRob2RPcChmdW5jdGlvbihndXR0ZXJJRCkge1xuICAgICAgdmFyIGNtID0gdGhpcywgZG9jID0gY20uZG9jLCBpID0gZG9jLmZpcnN0O1xuICAgICAgZG9jLml0ZXIoZnVuY3Rpb24obGluZSkge1xuICAgICAgICBpZiAobGluZS5ndXR0ZXJNYXJrZXJzICYmIGxpbmUuZ3V0dGVyTWFya2Vyc1tndXR0ZXJJRF0pIHtcbiAgICAgICAgICBsaW5lLmd1dHRlck1hcmtlcnNbZ3V0dGVySURdID0gbnVsbDtcbiAgICAgICAgICByZWdMaW5lQ2hhbmdlKGNtLCBpLCBcImd1dHRlclwiKTtcbiAgICAgICAgICBpZiAoaXNFbXB0eShsaW5lLmd1dHRlck1hcmtlcnMpKSBsaW5lLmd1dHRlck1hcmtlcnMgPSBudWxsO1xuICAgICAgICB9XG4gICAgICAgICsraTtcbiAgICAgIH0pO1xuICAgIH0pLFxuXG4gICAgYWRkTGluZVdpZGdldDogbWV0aG9kT3AoZnVuY3Rpb24oaGFuZGxlLCBub2RlLCBvcHRpb25zKSB7XG4gICAgICByZXR1cm4gYWRkTGluZVdpZGdldCh0aGlzLCBoYW5kbGUsIG5vZGUsIG9wdGlvbnMpO1xuICAgIH0pLFxuXG4gICAgcmVtb3ZlTGluZVdpZGdldDogZnVuY3Rpb24od2lkZ2V0KSB7IHdpZGdldC5jbGVhcigpOyB9LFxuXG4gICAgbGluZUluZm86IGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgIGlmICh0eXBlb2YgbGluZSA9PSBcIm51bWJlclwiKSB7XG4gICAgICAgIGlmICghaXNMaW5lKHRoaXMuZG9jLCBsaW5lKSkgcmV0dXJuIG51bGw7XG4gICAgICAgIHZhciBuID0gbGluZTtcbiAgICAgICAgbGluZSA9IGdldExpbmUodGhpcy5kb2MsIGxpbmUpO1xuICAgICAgICBpZiAoIWxpbmUpIHJldHVybiBudWxsO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIG4gPSBsaW5lTm8obGluZSk7XG4gICAgICAgIGlmIChuID09IG51bGwpIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHtsaW5lOiBuLCBoYW5kbGU6IGxpbmUsIHRleHQ6IGxpbmUudGV4dCwgZ3V0dGVyTWFya2VyczogbGluZS5ndXR0ZXJNYXJrZXJzLFxuICAgICAgICAgICAgICB0ZXh0Q2xhc3M6IGxpbmUudGV4dENsYXNzLCBiZ0NsYXNzOiBsaW5lLmJnQ2xhc3MsIHdyYXBDbGFzczogbGluZS53cmFwQ2xhc3MsXG4gICAgICAgICAgICAgIHdpZGdldHM6IGxpbmUud2lkZ2V0c307XG4gICAgfSxcblxuICAgIGdldFZpZXdwb3J0OiBmdW5jdGlvbigpIHsgcmV0dXJuIHtmcm9tOiB0aGlzLmRpc3BsYXkudmlld0Zyb20sIHRvOiB0aGlzLmRpc3BsYXkudmlld1RvfTt9LFxuXG4gICAgYWRkV2lkZ2V0OiBmdW5jdGlvbihwb3MsIG5vZGUsIHNjcm9sbCwgdmVydCwgaG9yaXopIHtcbiAgICAgIHZhciBkaXNwbGF5ID0gdGhpcy5kaXNwbGF5O1xuICAgICAgcG9zID0gY3Vyc29yQ29vcmRzKHRoaXMsIGNsaXBQb3ModGhpcy5kb2MsIHBvcykpO1xuICAgICAgdmFyIHRvcCA9IHBvcy5ib3R0b20sIGxlZnQgPSBwb3MubGVmdDtcbiAgICAgIG5vZGUuc3R5bGUucG9zaXRpb24gPSBcImFic29sdXRlXCI7XG4gICAgICBkaXNwbGF5LnNpemVyLmFwcGVuZENoaWxkKG5vZGUpO1xuICAgICAgaWYgKHZlcnQgPT0gXCJvdmVyXCIpIHtcbiAgICAgICAgdG9wID0gcG9zLnRvcDtcbiAgICAgIH0gZWxzZSBpZiAodmVydCA9PSBcImFib3ZlXCIgfHwgdmVydCA9PSBcIm5lYXJcIikge1xuICAgICAgICB2YXIgdnNwYWNlID0gTWF0aC5tYXgoZGlzcGxheS53cmFwcGVyLmNsaWVudEhlaWdodCwgdGhpcy5kb2MuaGVpZ2h0KSxcbiAgICAgICAgaHNwYWNlID0gTWF0aC5tYXgoZGlzcGxheS5zaXplci5jbGllbnRXaWR0aCwgZGlzcGxheS5saW5lU3BhY2UuY2xpZW50V2lkdGgpO1xuICAgICAgICAvLyBEZWZhdWx0IHRvIHBvc2l0aW9uaW5nIGFib3ZlIChpZiBzcGVjaWZpZWQgYW5kIHBvc3NpYmxlKTsgb3RoZXJ3aXNlIGRlZmF1bHQgdG8gcG9zaXRpb25pbmcgYmVsb3dcbiAgICAgICAgaWYgKCh2ZXJ0ID09ICdhYm92ZScgfHwgcG9zLmJvdHRvbSArIG5vZGUub2Zmc2V0SGVpZ2h0ID4gdnNwYWNlKSAmJiBwb3MudG9wID4gbm9kZS5vZmZzZXRIZWlnaHQpXG4gICAgICAgICAgdG9wID0gcG9zLnRvcCAtIG5vZGUub2Zmc2V0SGVpZ2h0O1xuICAgICAgICBlbHNlIGlmIChwb3MuYm90dG9tICsgbm9kZS5vZmZzZXRIZWlnaHQgPD0gdnNwYWNlKVxuICAgICAgICAgIHRvcCA9IHBvcy5ib3R0b207XG4gICAgICAgIGlmIChsZWZ0ICsgbm9kZS5vZmZzZXRXaWR0aCA+IGhzcGFjZSlcbiAgICAgICAgICBsZWZ0ID0gaHNwYWNlIC0gbm9kZS5vZmZzZXRXaWR0aDtcbiAgICAgIH1cbiAgICAgIG5vZGUuc3R5bGUudG9wID0gdG9wICsgXCJweFwiO1xuICAgICAgbm9kZS5zdHlsZS5sZWZ0ID0gbm9kZS5zdHlsZS5yaWdodCA9IFwiXCI7XG4gICAgICBpZiAoaG9yaXogPT0gXCJyaWdodFwiKSB7XG4gICAgICAgIGxlZnQgPSBkaXNwbGF5LnNpemVyLmNsaWVudFdpZHRoIC0gbm9kZS5vZmZzZXRXaWR0aDtcbiAgICAgICAgbm9kZS5zdHlsZS5yaWdodCA9IFwiMHB4XCI7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpZiAoaG9yaXogPT0gXCJsZWZ0XCIpIGxlZnQgPSAwO1xuICAgICAgICBlbHNlIGlmIChob3JpeiA9PSBcIm1pZGRsZVwiKSBsZWZ0ID0gKGRpc3BsYXkuc2l6ZXIuY2xpZW50V2lkdGggLSBub2RlLm9mZnNldFdpZHRoKSAvIDI7XG4gICAgICAgIG5vZGUuc3R5bGUubGVmdCA9IGxlZnQgKyBcInB4XCI7XG4gICAgICB9XG4gICAgICBpZiAoc2Nyb2xsKVxuICAgICAgICBzY3JvbGxJbnRvVmlldyh0aGlzLCBsZWZ0LCB0b3AsIGxlZnQgKyBub2RlLm9mZnNldFdpZHRoLCB0b3AgKyBub2RlLm9mZnNldEhlaWdodCk7XG4gICAgfSxcblxuICAgIHRyaWdnZXJPbktleURvd246IG1ldGhvZE9wKG9uS2V5RG93biksXG4gICAgdHJpZ2dlck9uS2V5UHJlc3M6IG1ldGhvZE9wKG9uS2V5UHJlc3MpLFxuICAgIHRyaWdnZXJPbktleVVwOiBvbktleVVwLFxuXG4gICAgZXhlY0NvbW1hbmQ6IGZ1bmN0aW9uKGNtZCkge1xuICAgICAgaWYgKGNvbW1hbmRzLmhhc093blByb3BlcnR5KGNtZCkpXG4gICAgICAgIHJldHVybiBjb21tYW5kc1tjbWRdKHRoaXMpO1xuICAgIH0sXG5cbiAgICBmaW5kUG9zSDogZnVuY3Rpb24oZnJvbSwgYW1vdW50LCB1bml0LCB2aXN1YWxseSkge1xuICAgICAgdmFyIGRpciA9IDE7XG4gICAgICBpZiAoYW1vdW50IDwgMCkgeyBkaXIgPSAtMTsgYW1vdW50ID0gLWFtb3VudDsgfVxuICAgICAgZm9yICh2YXIgaSA9IDAsIGN1ciA9IGNsaXBQb3ModGhpcy5kb2MsIGZyb20pOyBpIDwgYW1vdW50OyArK2kpIHtcbiAgICAgICAgY3VyID0gZmluZFBvc0godGhpcy5kb2MsIGN1ciwgZGlyLCB1bml0LCB2aXN1YWxseSk7XG4gICAgICAgIGlmIChjdXIuaGl0U2lkZSkgYnJlYWs7XG4gICAgICB9XG4gICAgICByZXR1cm4gY3VyO1xuICAgIH0sXG5cbiAgICBtb3ZlSDogbWV0aG9kT3AoZnVuY3Rpb24oZGlyLCB1bml0KSB7XG4gICAgICB2YXIgY20gPSB0aGlzO1xuICAgICAgY20uZXh0ZW5kU2VsZWN0aW9uc0J5KGZ1bmN0aW9uKHJhbmdlKSB7XG4gICAgICAgIGlmIChjbS5kaXNwbGF5LnNoaWZ0IHx8IGNtLmRvYy5leHRlbmQgfHwgcmFuZ2UuZW1wdHkoKSlcbiAgICAgICAgICByZXR1cm4gZmluZFBvc0goY20uZG9jLCByYW5nZS5oZWFkLCBkaXIsIHVuaXQsIGNtLm9wdGlvbnMucnRsTW92ZVZpc3VhbGx5KTtcbiAgICAgICAgZWxzZVxuICAgICAgICAgIHJldHVybiBkaXIgPCAwID8gcmFuZ2UuZnJvbSgpIDogcmFuZ2UudG8oKTtcbiAgICAgIH0sIHNlbF9tb3ZlKTtcbiAgICB9KSxcblxuICAgIGRlbGV0ZUg6IG1ldGhvZE9wKGZ1bmN0aW9uKGRpciwgdW5pdCkge1xuICAgICAgdmFyIHNlbCA9IHRoaXMuZG9jLnNlbCwgZG9jID0gdGhpcy5kb2M7XG4gICAgICBpZiAoc2VsLnNvbWV0aGluZ1NlbGVjdGVkKCkpXG4gICAgICAgIGRvYy5yZXBsYWNlU2VsZWN0aW9uKFwiXCIsIG51bGwsIFwiK2RlbGV0ZVwiKTtcbiAgICAgIGVsc2VcbiAgICAgICAgZGVsZXRlTmVhclNlbGVjdGlvbih0aGlzLCBmdW5jdGlvbihyYW5nZSkge1xuICAgICAgICAgIHZhciBvdGhlciA9IGZpbmRQb3NIKGRvYywgcmFuZ2UuaGVhZCwgZGlyLCB1bml0LCBmYWxzZSk7XG4gICAgICAgICAgcmV0dXJuIGRpciA8IDAgPyB7ZnJvbTogb3RoZXIsIHRvOiByYW5nZS5oZWFkfSA6IHtmcm9tOiByYW5nZS5oZWFkLCB0bzogb3RoZXJ9O1xuICAgICAgICB9KTtcbiAgICB9KSxcblxuICAgIGZpbmRQb3NWOiBmdW5jdGlvbihmcm9tLCBhbW91bnQsIHVuaXQsIGdvYWxDb2x1bW4pIHtcbiAgICAgIHZhciBkaXIgPSAxLCB4ID0gZ29hbENvbHVtbjtcbiAgICAgIGlmIChhbW91bnQgPCAwKSB7IGRpciA9IC0xOyBhbW91bnQgPSAtYW1vdW50OyB9XG4gICAgICBmb3IgKHZhciBpID0gMCwgY3VyID0gY2xpcFBvcyh0aGlzLmRvYywgZnJvbSk7IGkgPCBhbW91bnQ7ICsraSkge1xuICAgICAgICB2YXIgY29vcmRzID0gY3Vyc29yQ29vcmRzKHRoaXMsIGN1ciwgXCJkaXZcIik7XG4gICAgICAgIGlmICh4ID09IG51bGwpIHggPSBjb29yZHMubGVmdDtcbiAgICAgICAgZWxzZSBjb29yZHMubGVmdCA9IHg7XG4gICAgICAgIGN1ciA9IGZpbmRQb3NWKHRoaXMsIGNvb3JkcywgZGlyLCB1bml0KTtcbiAgICAgICAgaWYgKGN1ci5oaXRTaWRlKSBicmVhaztcbiAgICAgIH1cbiAgICAgIHJldHVybiBjdXI7XG4gICAgfSxcblxuICAgIG1vdmVWOiBtZXRob2RPcChmdW5jdGlvbihkaXIsIHVuaXQpIHtcbiAgICAgIHZhciBjbSA9IHRoaXMsIGRvYyA9IHRoaXMuZG9jLCBnb2FscyA9IFtdO1xuICAgICAgdmFyIGNvbGxhcHNlID0gIWNtLmRpc3BsYXkuc2hpZnQgJiYgIWRvYy5leHRlbmQgJiYgZG9jLnNlbC5zb21ldGhpbmdTZWxlY3RlZCgpO1xuICAgICAgZG9jLmV4dGVuZFNlbGVjdGlvbnNCeShmdW5jdGlvbihyYW5nZSkge1xuICAgICAgICBpZiAoY29sbGFwc2UpXG4gICAgICAgICAgcmV0dXJuIGRpciA8IDAgPyByYW5nZS5mcm9tKCkgOiByYW5nZS50bygpO1xuICAgICAgICB2YXIgaGVhZFBvcyA9IGN1cnNvckNvb3JkcyhjbSwgcmFuZ2UuaGVhZCwgXCJkaXZcIik7XG4gICAgICAgIGlmIChyYW5nZS5nb2FsQ29sdW1uICE9IG51bGwpIGhlYWRQb3MubGVmdCA9IHJhbmdlLmdvYWxDb2x1bW47XG4gICAgICAgIGdvYWxzLnB1c2goaGVhZFBvcy5sZWZ0KTtcbiAgICAgICAgdmFyIHBvcyA9IGZpbmRQb3NWKGNtLCBoZWFkUG9zLCBkaXIsIHVuaXQpO1xuICAgICAgICBpZiAodW5pdCA9PSBcInBhZ2VcIiAmJiByYW5nZSA9PSBkb2Muc2VsLnByaW1hcnkoKSlcbiAgICAgICAgICBhZGRUb1Njcm9sbFBvcyhjbSwgbnVsbCwgY2hhckNvb3JkcyhjbSwgcG9zLCBcImRpdlwiKS50b3AgLSBoZWFkUG9zLnRvcCk7XG4gICAgICAgIHJldHVybiBwb3M7XG4gICAgICB9LCBzZWxfbW92ZSk7XG4gICAgICBpZiAoZ29hbHMubGVuZ3RoKSBmb3IgKHZhciBpID0gMDsgaSA8IGRvYy5zZWwucmFuZ2VzLmxlbmd0aDsgaSsrKVxuICAgICAgICBkb2Muc2VsLnJhbmdlc1tpXS5nb2FsQ29sdW1uID0gZ29hbHNbaV07XG4gICAgfSksXG5cbiAgICB0b2dnbGVPdmVyd3JpdGU6IGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgICBpZiAodmFsdWUgIT0gbnVsbCAmJiB2YWx1ZSA9PSB0aGlzLnN0YXRlLm92ZXJ3cml0ZSkgcmV0dXJuO1xuICAgICAgaWYgKHRoaXMuc3RhdGUub3ZlcndyaXRlID0gIXRoaXMuc3RhdGUub3ZlcndyaXRlKVxuICAgICAgICBhZGRDbGFzcyh0aGlzLmRpc3BsYXkuY3Vyc29yRGl2LCBcIkNvZGVNaXJyb3Itb3ZlcndyaXRlXCIpO1xuICAgICAgZWxzZVxuICAgICAgICBybUNsYXNzKHRoaXMuZGlzcGxheS5jdXJzb3JEaXYsIFwiQ29kZU1pcnJvci1vdmVyd3JpdGVcIik7XG5cbiAgICAgIHNpZ25hbCh0aGlzLCBcIm92ZXJ3cml0ZVRvZ2dsZVwiLCB0aGlzLCB0aGlzLnN0YXRlLm92ZXJ3cml0ZSk7XG4gICAgfSxcbiAgICBoYXNGb2N1czogZnVuY3Rpb24oKSB7IHJldHVybiBhY3RpdmVFbHQoKSA9PSB0aGlzLmRpc3BsYXkuaW5wdXQ7IH0sXG5cbiAgICBzY3JvbGxUbzogbWV0aG9kT3AoZnVuY3Rpb24oeCwgeSkge1xuICAgICAgaWYgKHggIT0gbnVsbCB8fCB5ICE9IG51bGwpIHJlc29sdmVTY3JvbGxUb1Bvcyh0aGlzKTtcbiAgICAgIGlmICh4ICE9IG51bGwpIHRoaXMuY3VyT3Auc2Nyb2xsTGVmdCA9IHg7XG4gICAgICBpZiAoeSAhPSBudWxsKSB0aGlzLmN1ck9wLnNjcm9sbFRvcCA9IHk7XG4gICAgfSksXG4gICAgZ2V0U2Nyb2xsSW5mbzogZnVuY3Rpb24oKSB7XG4gICAgICB2YXIgc2Nyb2xsZXIgPSB0aGlzLmRpc3BsYXkuc2Nyb2xsZXIsIGNvID0gc2Nyb2xsZXJDdXRPZmY7XG4gICAgICByZXR1cm4ge2xlZnQ6IHNjcm9sbGVyLnNjcm9sbExlZnQsIHRvcDogc2Nyb2xsZXIuc2Nyb2xsVG9wLFxuICAgICAgICAgICAgICBoZWlnaHQ6IHNjcm9sbGVyLnNjcm9sbEhlaWdodCAtIGNvLCB3aWR0aDogc2Nyb2xsZXIuc2Nyb2xsV2lkdGggLSBjbyxcbiAgICAgICAgICAgICAgY2xpZW50SGVpZ2h0OiBzY3JvbGxlci5jbGllbnRIZWlnaHQgLSBjbywgY2xpZW50V2lkdGg6IHNjcm9sbGVyLmNsaWVudFdpZHRoIC0gY299O1xuICAgIH0sXG5cbiAgICBzY3JvbGxJbnRvVmlldzogbWV0aG9kT3AoZnVuY3Rpb24ocmFuZ2UsIG1hcmdpbikge1xuICAgICAgaWYgKHJhbmdlID09IG51bGwpIHtcbiAgICAgICAgcmFuZ2UgPSB7ZnJvbTogdGhpcy5kb2Muc2VsLnByaW1hcnkoKS5oZWFkLCB0bzogbnVsbH07XG4gICAgICAgIGlmIChtYXJnaW4gPT0gbnVsbCkgbWFyZ2luID0gdGhpcy5vcHRpb25zLmN1cnNvclNjcm9sbE1hcmdpbjtcbiAgICAgIH0gZWxzZSBpZiAodHlwZW9mIHJhbmdlID09IFwibnVtYmVyXCIpIHtcbiAgICAgICAgcmFuZ2UgPSB7ZnJvbTogUG9zKHJhbmdlLCAwKSwgdG86IG51bGx9O1xuICAgICAgfSBlbHNlIGlmIChyYW5nZS5mcm9tID09IG51bGwpIHtcbiAgICAgICAgcmFuZ2UgPSB7ZnJvbTogcmFuZ2UsIHRvOiBudWxsfTtcbiAgICAgIH1cbiAgICAgIGlmICghcmFuZ2UudG8pIHJhbmdlLnRvID0gcmFuZ2UuZnJvbTtcbiAgICAgIHJhbmdlLm1hcmdpbiA9IG1hcmdpbiB8fCAwO1xuXG4gICAgICBpZiAocmFuZ2UuZnJvbS5saW5lICE9IG51bGwpIHtcbiAgICAgICAgcmVzb2x2ZVNjcm9sbFRvUG9zKHRoaXMpO1xuICAgICAgICB0aGlzLmN1ck9wLnNjcm9sbFRvUG9zID0gcmFuZ2U7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB2YXIgc1BvcyA9IGNhbGN1bGF0ZVNjcm9sbFBvcyh0aGlzLCBNYXRoLm1pbihyYW5nZS5mcm9tLmxlZnQsIHJhbmdlLnRvLmxlZnQpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBNYXRoLm1pbihyYW5nZS5mcm9tLnRvcCwgcmFuZ2UudG8udG9wKSAtIHJhbmdlLm1hcmdpbixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgTWF0aC5tYXgocmFuZ2UuZnJvbS5yaWdodCwgcmFuZ2UudG8ucmlnaHQpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBNYXRoLm1heChyYW5nZS5mcm9tLmJvdHRvbSwgcmFuZ2UudG8uYm90dG9tKSArIHJhbmdlLm1hcmdpbik7XG4gICAgICAgIHRoaXMuc2Nyb2xsVG8oc1Bvcy5zY3JvbGxMZWZ0LCBzUG9zLnNjcm9sbFRvcCk7XG4gICAgICB9XG4gICAgfSksXG5cbiAgICBzZXRTaXplOiBtZXRob2RPcChmdW5jdGlvbih3aWR0aCwgaGVpZ2h0KSB7XG4gICAgICB2YXIgY20gPSB0aGlzO1xuICAgICAgZnVuY3Rpb24gaW50ZXJwcmV0KHZhbCkge1xuICAgICAgICByZXR1cm4gdHlwZW9mIHZhbCA9PSBcIm51bWJlclwiIHx8IC9eXFxkKyQvLnRlc3QoU3RyaW5nKHZhbCkpID8gdmFsICsgXCJweFwiIDogdmFsO1xuICAgICAgfVxuICAgICAgaWYgKHdpZHRoICE9IG51bGwpIGNtLmRpc3BsYXkud3JhcHBlci5zdHlsZS53aWR0aCA9IGludGVycHJldCh3aWR0aCk7XG4gICAgICBpZiAoaGVpZ2h0ICE9IG51bGwpIGNtLmRpc3BsYXkud3JhcHBlci5zdHlsZS5oZWlnaHQgPSBpbnRlcnByZXQoaGVpZ2h0KTtcbiAgICAgIGlmIChjbS5vcHRpb25zLmxpbmVXcmFwcGluZykgY2xlYXJMaW5lTWVhc3VyZW1lbnRDYWNoZSh0aGlzKTtcbiAgICAgIHZhciBsaW5lTm8gPSBjbS5kaXNwbGF5LnZpZXdGcm9tO1xuICAgICAgY20uZG9jLml0ZXIobGluZU5vLCBjbS5kaXNwbGF5LnZpZXdUbywgZnVuY3Rpb24obGluZSkge1xuICAgICAgICBpZiAobGluZS53aWRnZXRzKSBmb3IgKHZhciBpID0gMDsgaSA8IGxpbmUud2lkZ2V0cy5sZW5ndGg7IGkrKylcbiAgICAgICAgICBpZiAobGluZS53aWRnZXRzW2ldLm5vSFNjcm9sbCkgeyByZWdMaW5lQ2hhbmdlKGNtLCBsaW5lTm8sIFwid2lkZ2V0XCIpOyBicmVhazsgfVxuICAgICAgICArK2xpbmVObztcbiAgICAgIH0pO1xuICAgICAgY20uY3VyT3AuZm9yY2VVcGRhdGUgPSB0cnVlO1xuICAgICAgc2lnbmFsKGNtLCBcInJlZnJlc2hcIiwgdGhpcyk7XG4gICAgfSksXG5cbiAgICBvcGVyYXRpb246IGZ1bmN0aW9uKGYpe3JldHVybiBydW5Jbk9wKHRoaXMsIGYpO30sXG5cbiAgICByZWZyZXNoOiBtZXRob2RPcChmdW5jdGlvbigpIHtcbiAgICAgIHZhciBvbGRIZWlnaHQgPSB0aGlzLmRpc3BsYXkuY2FjaGVkVGV4dEhlaWdodDtcbiAgICAgIHJlZ0NoYW5nZSh0aGlzKTtcbiAgICAgIHRoaXMuY3VyT3AuZm9yY2VVcGRhdGUgPSB0cnVlO1xuICAgICAgY2xlYXJDYWNoZXModGhpcyk7XG4gICAgICB0aGlzLnNjcm9sbFRvKHRoaXMuZG9jLnNjcm9sbExlZnQsIHRoaXMuZG9jLnNjcm9sbFRvcCk7XG4gICAgICB1cGRhdGVHdXR0ZXJTcGFjZSh0aGlzKTtcbiAgICAgIGlmIChvbGRIZWlnaHQgPT0gbnVsbCB8fCBNYXRoLmFicyhvbGRIZWlnaHQgLSB0ZXh0SGVpZ2h0KHRoaXMuZGlzcGxheSkpID4gLjUpXG4gICAgICAgIGVzdGltYXRlTGluZUhlaWdodHModGhpcyk7XG4gICAgICBzaWduYWwodGhpcywgXCJyZWZyZXNoXCIsIHRoaXMpO1xuICAgIH0pLFxuXG4gICAgc3dhcERvYzogbWV0aG9kT3AoZnVuY3Rpb24oZG9jKSB7XG4gICAgICB2YXIgb2xkID0gdGhpcy5kb2M7XG4gICAgICBvbGQuY20gPSBudWxsO1xuICAgICAgYXR0YWNoRG9jKHRoaXMsIGRvYyk7XG4gICAgICBjbGVhckNhY2hlcyh0aGlzKTtcbiAgICAgIHJlc2V0SW5wdXQodGhpcyk7XG4gICAgICB0aGlzLnNjcm9sbFRvKGRvYy5zY3JvbGxMZWZ0LCBkb2Muc2Nyb2xsVG9wKTtcbiAgICAgIHNpZ25hbExhdGVyKHRoaXMsIFwic3dhcERvY1wiLCB0aGlzLCBvbGQpO1xuICAgICAgcmV0dXJuIG9sZDtcbiAgICB9KSxcblxuICAgIGdldElucHV0RmllbGQ6IGZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuZGlzcGxheS5pbnB1dDt9LFxuICAgIGdldFdyYXBwZXJFbGVtZW50OiBmdW5jdGlvbigpe3JldHVybiB0aGlzLmRpc3BsYXkud3JhcHBlcjt9LFxuICAgIGdldFNjcm9sbGVyRWxlbWVudDogZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5kaXNwbGF5LnNjcm9sbGVyO30sXG4gICAgZ2V0R3V0dGVyRWxlbWVudDogZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5kaXNwbGF5Lmd1dHRlcnM7fVxuICB9O1xuICBldmVudE1peGluKENvZGVNaXJyb3IpO1xuXG4gIC8vIE9QVElPTiBERUZBVUxUU1xuXG4gIC8vIFRoZSBkZWZhdWx0IGNvbmZpZ3VyYXRpb24gb3B0aW9ucy5cbiAgdmFyIGRlZmF1bHRzID0gQ29kZU1pcnJvci5kZWZhdWx0cyA9IHt9O1xuICAvLyBGdW5jdGlvbnMgdG8gcnVuIHdoZW4gb3B0aW9ucyBhcmUgY2hhbmdlZC5cbiAgdmFyIG9wdGlvbkhhbmRsZXJzID0gQ29kZU1pcnJvci5vcHRpb25IYW5kbGVycyA9IHt9O1xuXG4gIGZ1bmN0aW9uIG9wdGlvbihuYW1lLCBkZWZsdCwgaGFuZGxlLCBub3RPbkluaXQpIHtcbiAgICBDb2RlTWlycm9yLmRlZmF1bHRzW25hbWVdID0gZGVmbHQ7XG4gICAgaWYgKGhhbmRsZSkgb3B0aW9uSGFuZGxlcnNbbmFtZV0gPVxuICAgICAgbm90T25Jbml0ID8gZnVuY3Rpb24oY20sIHZhbCwgb2xkKSB7aWYgKG9sZCAhPSBJbml0KSBoYW5kbGUoY20sIHZhbCwgb2xkKTt9IDogaGFuZGxlO1xuICB9XG5cbiAgLy8gUGFzc2VkIHRvIG9wdGlvbiBoYW5kbGVycyB3aGVuIHRoZXJlIGlzIG5vIG9sZCB2YWx1ZS5cbiAgdmFyIEluaXQgPSBDb2RlTWlycm9yLkluaXQgPSB7dG9TdHJpbmc6IGZ1bmN0aW9uKCl7cmV0dXJuIFwiQ29kZU1pcnJvci5Jbml0XCI7fX07XG5cbiAgLy8gVGhlc2UgdHdvIGFyZSwgb24gaW5pdCwgY2FsbGVkIGZyb20gdGhlIGNvbnN0cnVjdG9yIGJlY2F1c2UgdGhleVxuICAvLyBoYXZlIHRvIGJlIGluaXRpYWxpemVkIGJlZm9yZSB0aGUgZWRpdG9yIGNhbiBzdGFydCBhdCBhbGwuXG4gIG9wdGlvbihcInZhbHVlXCIsIFwiXCIsIGZ1bmN0aW9uKGNtLCB2YWwpIHtcbiAgICBjbS5zZXRWYWx1ZSh2YWwpO1xuICB9LCB0cnVlKTtcbiAgb3B0aW9uKFwibW9kZVwiLCBudWxsLCBmdW5jdGlvbihjbSwgdmFsKSB7XG4gICAgY20uZG9jLm1vZGVPcHRpb24gPSB2YWw7XG4gICAgbG9hZE1vZGUoY20pO1xuICB9LCB0cnVlKTtcblxuICBvcHRpb24oXCJpbmRlbnRVbml0XCIsIDIsIGxvYWRNb2RlLCB0cnVlKTtcbiAgb3B0aW9uKFwiaW5kZW50V2l0aFRhYnNcIiwgZmFsc2UpO1xuICBvcHRpb24oXCJzbWFydEluZGVudFwiLCB0cnVlKTtcbiAgb3B0aW9uKFwidGFiU2l6ZVwiLCA0LCBmdW5jdGlvbihjbSkge1xuICAgIHJlc2V0TW9kZVN0YXRlKGNtKTtcbiAgICBjbGVhckNhY2hlcyhjbSk7XG4gICAgcmVnQ2hhbmdlKGNtKTtcbiAgfSwgdHJ1ZSk7XG4gIG9wdGlvbihcInNwZWNpYWxDaGFyc1wiLCAvW1xcdFxcdTAwMDAtXFx1MDAxOVxcdTAwYWRcXHUyMDBiXFx1MjAyOFxcdTIwMjlcXHVmZWZmXS9nLCBmdW5jdGlvbihjbSwgdmFsKSB7XG4gICAgY20ub3B0aW9ucy5zcGVjaWFsQ2hhcnMgPSBuZXcgUmVnRXhwKHZhbC5zb3VyY2UgKyAodmFsLnRlc3QoXCJcXHRcIikgPyBcIlwiIDogXCJ8XFx0XCIpLCBcImdcIik7XG4gICAgY20ucmVmcmVzaCgpO1xuICB9LCB0cnVlKTtcbiAgb3B0aW9uKFwic3BlY2lhbENoYXJQbGFjZWhvbGRlclwiLCBkZWZhdWx0U3BlY2lhbENoYXJQbGFjZWhvbGRlciwgZnVuY3Rpb24oY20pIHtjbS5yZWZyZXNoKCk7fSwgdHJ1ZSk7XG4gIG9wdGlvbihcImVsZWN0cmljQ2hhcnNcIiwgdHJ1ZSk7XG4gIG9wdGlvbihcInJ0bE1vdmVWaXN1YWxseVwiLCAhd2luZG93cyk7XG4gIG9wdGlvbihcIndob2xlTGluZVVwZGF0ZUJlZm9yZVwiLCB0cnVlKTtcblxuICBvcHRpb24oXCJ0aGVtZVwiLCBcImRlZmF1bHRcIiwgZnVuY3Rpb24oY20pIHtcbiAgICB0aGVtZUNoYW5nZWQoY20pO1xuICAgIGd1dHRlcnNDaGFuZ2VkKGNtKTtcbiAgfSwgdHJ1ZSk7XG4gIG9wdGlvbihcImtleU1hcFwiLCBcImRlZmF1bHRcIiwga2V5TWFwQ2hhbmdlZCk7XG4gIG9wdGlvbihcImV4dHJhS2V5c1wiLCBudWxsKTtcblxuICBvcHRpb24oXCJsaW5lV3JhcHBpbmdcIiwgZmFsc2UsIHdyYXBwaW5nQ2hhbmdlZCwgdHJ1ZSk7XG4gIG9wdGlvbihcImd1dHRlcnNcIiwgW10sIGZ1bmN0aW9uKGNtKSB7XG4gICAgc2V0R3V0dGVyc0ZvckxpbmVOdW1iZXJzKGNtLm9wdGlvbnMpO1xuICAgIGd1dHRlcnNDaGFuZ2VkKGNtKTtcbiAgfSwgdHJ1ZSk7XG4gIG9wdGlvbihcImZpeGVkR3V0dGVyXCIsIHRydWUsIGZ1bmN0aW9uKGNtLCB2YWwpIHtcbiAgICBjbS5kaXNwbGF5Lmd1dHRlcnMuc3R5bGUubGVmdCA9IHZhbCA/IGNvbXBlbnNhdGVGb3JIU2Nyb2xsKGNtLmRpc3BsYXkpICsgXCJweFwiIDogXCIwXCI7XG4gICAgY20ucmVmcmVzaCgpO1xuICB9LCB0cnVlKTtcbiAgb3B0aW9uKFwiY292ZXJHdXR0ZXJOZXh0VG9TY3JvbGxiYXJcIiwgZmFsc2UsIHVwZGF0ZVNjcm9sbGJhcnMsIHRydWUpO1xuICBvcHRpb24oXCJsaW5lTnVtYmVyc1wiLCBmYWxzZSwgZnVuY3Rpb24oY20pIHtcbiAgICBzZXRHdXR0ZXJzRm9yTGluZU51bWJlcnMoY20ub3B0aW9ucyk7XG4gICAgZ3V0dGVyc0NoYW5nZWQoY20pO1xuICB9LCB0cnVlKTtcbiAgb3B0aW9uKFwiZmlyc3RMaW5lTnVtYmVyXCIsIDEsIGd1dHRlcnNDaGFuZ2VkLCB0cnVlKTtcbiAgb3B0aW9uKFwibGluZU51bWJlckZvcm1hdHRlclwiLCBmdW5jdGlvbihpbnRlZ2VyKSB7cmV0dXJuIGludGVnZXI7fSwgZ3V0dGVyc0NoYW5nZWQsIHRydWUpO1xuICBvcHRpb24oXCJzaG93Q3Vyc29yV2hlblNlbGVjdGluZ1wiLCBmYWxzZSwgdXBkYXRlU2VsZWN0aW9uLCB0cnVlKTtcblxuICBvcHRpb24oXCJyZXNldFNlbGVjdGlvbk9uQ29udGV4dE1lbnVcIiwgdHJ1ZSk7XG5cbiAgb3B0aW9uKFwicmVhZE9ubHlcIiwgZmFsc2UsIGZ1bmN0aW9uKGNtLCB2YWwpIHtcbiAgICBpZiAodmFsID09IFwibm9jdXJzb3JcIikge1xuICAgICAgb25CbHVyKGNtKTtcbiAgICAgIGNtLmRpc3BsYXkuaW5wdXQuYmx1cigpO1xuICAgICAgY20uZGlzcGxheS5kaXNhYmxlZCA9IHRydWU7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNtLmRpc3BsYXkuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgIGlmICghdmFsKSByZXNldElucHV0KGNtKTtcbiAgICB9XG4gIH0pO1xuICBvcHRpb24oXCJkaXNhYmxlSW5wdXRcIiwgZmFsc2UsIGZ1bmN0aW9uKGNtLCB2YWwpIHtpZiAoIXZhbCkgcmVzZXRJbnB1dChjbSk7fSwgdHJ1ZSk7XG4gIG9wdGlvbihcImRyYWdEcm9wXCIsIHRydWUpO1xuXG4gIG9wdGlvbihcImN1cnNvckJsaW5rUmF0ZVwiLCA1MzApO1xuICBvcHRpb24oXCJjdXJzb3JTY3JvbGxNYXJnaW5cIiwgMCk7XG4gIG9wdGlvbihcImN1cnNvckhlaWdodFwiLCAxLCB1cGRhdGVTZWxlY3Rpb24sIHRydWUpO1xuICBvcHRpb24oXCJzaW5nbGVDdXJzb3JIZWlnaHRQZXJMaW5lXCIsIHRydWUsIHVwZGF0ZVNlbGVjdGlvbiwgdHJ1ZSk7XG4gIG9wdGlvbihcIndvcmtUaW1lXCIsIDEwMCk7XG4gIG9wdGlvbihcIndvcmtEZWxheVwiLCAxMDApO1xuICBvcHRpb24oXCJmbGF0dGVuU3BhbnNcIiwgdHJ1ZSwgcmVzZXRNb2RlU3RhdGUsIHRydWUpO1xuICBvcHRpb24oXCJhZGRNb2RlQ2xhc3NcIiwgZmFsc2UsIHJlc2V0TW9kZVN0YXRlLCB0cnVlKTtcbiAgb3B0aW9uKFwicG9sbEludGVydmFsXCIsIDEwMCk7XG4gIG9wdGlvbihcInVuZG9EZXB0aFwiLCAyMDAsIGZ1bmN0aW9uKGNtLCB2YWwpe2NtLmRvYy5oaXN0b3J5LnVuZG9EZXB0aCA9IHZhbDt9KTtcbiAgb3B0aW9uKFwiaGlzdG9yeUV2ZW50RGVsYXlcIiwgMTI1MCk7XG4gIG9wdGlvbihcInZpZXdwb3J0TWFyZ2luXCIsIDEwLCBmdW5jdGlvbihjbSl7Y20ucmVmcmVzaCgpO30sIHRydWUpO1xuICBvcHRpb24oXCJtYXhIaWdobGlnaHRMZW5ndGhcIiwgMTAwMDAsIHJlc2V0TW9kZVN0YXRlLCB0cnVlKTtcbiAgb3B0aW9uKFwibW92ZUlucHV0V2l0aEN1cnNvclwiLCB0cnVlLCBmdW5jdGlvbihjbSwgdmFsKSB7XG4gICAgaWYgKCF2YWwpIGNtLmRpc3BsYXkuaW5wdXREaXYuc3R5bGUudG9wID0gY20uZGlzcGxheS5pbnB1dERpdi5zdHlsZS5sZWZ0ID0gMDtcbiAgfSk7XG5cbiAgb3B0aW9uKFwidGFiaW5kZXhcIiwgbnVsbCwgZnVuY3Rpb24oY20sIHZhbCkge1xuICAgIGNtLmRpc3BsYXkuaW5wdXQudGFiSW5kZXggPSB2YWwgfHwgXCJcIjtcbiAgfSk7XG4gIG9wdGlvbihcImF1dG9mb2N1c1wiLCBudWxsKTtcblxuICAvLyBNT0RFIERFRklOSVRJT04gQU5EIFFVRVJZSU5HXG5cbiAgLy8gS25vd24gbW9kZXMsIGJ5IG5hbWUgYW5kIGJ5IE1JTUVcbiAgdmFyIG1vZGVzID0gQ29kZU1pcnJvci5tb2RlcyA9IHt9LCBtaW1lTW9kZXMgPSBDb2RlTWlycm9yLm1pbWVNb2RlcyA9IHt9O1xuXG4gIC8vIEV4dHJhIGFyZ3VtZW50cyBhcmUgc3RvcmVkIGFzIHRoZSBtb2RlJ3MgZGVwZW5kZW5jaWVzLCB3aGljaCBpc1xuICAvLyB1c2VkIGJ5IChsZWdhY3kpIG1lY2hhbmlzbXMgbGlrZSBsb2FkbW9kZS5qcyB0byBhdXRvbWF0aWNhbGx5XG4gIC8vIGxvYWQgYSBtb2RlLiAoUHJlZmVycmVkIG1lY2hhbmlzbSBpcyB0aGUgcmVxdWlyZS9kZWZpbmUgY2FsbHMuKVxuICBDb2RlTWlycm9yLmRlZmluZU1vZGUgPSBmdW5jdGlvbihuYW1lLCBtb2RlKSB7XG4gICAgaWYgKCFDb2RlTWlycm9yLmRlZmF1bHRzLm1vZGUgJiYgbmFtZSAhPSBcIm51bGxcIikgQ29kZU1pcnJvci5kZWZhdWx0cy5tb2RlID0gbmFtZTtcbiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+IDIpIHtcbiAgICAgIG1vZGUuZGVwZW5kZW5jaWVzID0gW107XG4gICAgICBmb3IgKHZhciBpID0gMjsgaSA8IGFyZ3VtZW50cy5sZW5ndGg7ICsraSkgbW9kZS5kZXBlbmRlbmNpZXMucHVzaChhcmd1bWVudHNbaV0pO1xuICAgIH1cbiAgICBtb2Rlc1tuYW1lXSA9IG1vZGU7XG4gIH07XG5cbiAgQ29kZU1pcnJvci5kZWZpbmVNSU1FID0gZnVuY3Rpb24obWltZSwgc3BlYykge1xuICAgIG1pbWVNb2Rlc1ttaW1lXSA9IHNwZWM7XG4gIH07XG5cbiAgLy8gR2l2ZW4gYSBNSU1FIHR5cGUsIGEge25hbWUsIC4uLm9wdGlvbnN9IGNvbmZpZyBvYmplY3QsIG9yIGEgbmFtZVxuICAvLyBzdHJpbmcsIHJldHVybiBhIG1vZGUgY29uZmlnIG9iamVjdC5cbiAgQ29kZU1pcnJvci5yZXNvbHZlTW9kZSA9IGZ1bmN0aW9uKHNwZWMpIHtcbiAgICBpZiAodHlwZW9mIHNwZWMgPT0gXCJzdHJpbmdcIiAmJiBtaW1lTW9kZXMuaGFzT3duUHJvcGVydHkoc3BlYykpIHtcbiAgICAgIHNwZWMgPSBtaW1lTW9kZXNbc3BlY107XG4gICAgfSBlbHNlIGlmIChzcGVjICYmIHR5cGVvZiBzcGVjLm5hbWUgPT0gXCJzdHJpbmdcIiAmJiBtaW1lTW9kZXMuaGFzT3duUHJvcGVydHkoc3BlYy5uYW1lKSkge1xuICAgICAgdmFyIGZvdW5kID0gbWltZU1vZGVzW3NwZWMubmFtZV07XG4gICAgICBpZiAodHlwZW9mIGZvdW5kID09IFwic3RyaW5nXCIpIGZvdW5kID0ge25hbWU6IGZvdW5kfTtcbiAgICAgIHNwZWMgPSBjcmVhdGVPYmooZm91bmQsIHNwZWMpO1xuICAgICAgc3BlYy5uYW1lID0gZm91bmQubmFtZTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBzcGVjID09IFwic3RyaW5nXCIgJiYgL15bXFx3XFwtXStcXC9bXFx3XFwtXStcXCt4bWwkLy50ZXN0KHNwZWMpKSB7XG4gICAgICByZXR1cm4gQ29kZU1pcnJvci5yZXNvbHZlTW9kZShcImFwcGxpY2F0aW9uL3htbFwiKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBzcGVjID09IFwic3RyaW5nXCIpIHJldHVybiB7bmFtZTogc3BlY307XG4gICAgZWxzZSByZXR1cm4gc3BlYyB8fCB7bmFtZTogXCJudWxsXCJ9O1xuICB9O1xuXG4gIC8vIEdpdmVuIGEgbW9kZSBzcGVjIChhbnl0aGluZyB0aGF0IHJlc29sdmVNb2RlIGFjY2VwdHMpLCBmaW5kIGFuZFxuICAvLyBpbml0aWFsaXplIGFuIGFjdHVhbCBtb2RlIG9iamVjdC5cbiAgQ29kZU1pcnJvci5nZXRNb2RlID0gZnVuY3Rpb24ob3B0aW9ucywgc3BlYykge1xuICAgIHZhciBzcGVjID0gQ29kZU1pcnJvci5yZXNvbHZlTW9kZShzcGVjKTtcbiAgICB2YXIgbWZhY3RvcnkgPSBtb2Rlc1tzcGVjLm5hbWVdO1xuICAgIGlmICghbWZhY3RvcnkpIHJldHVybiBDb2RlTWlycm9yLmdldE1vZGUob3B0aW9ucywgXCJ0ZXh0L3BsYWluXCIpO1xuICAgIHZhciBtb2RlT2JqID0gbWZhY3Rvcnkob3B0aW9ucywgc3BlYyk7XG4gICAgaWYgKG1vZGVFeHRlbnNpb25zLmhhc093blByb3BlcnR5KHNwZWMubmFtZSkpIHtcbiAgICAgIHZhciBleHRzID0gbW9kZUV4dGVuc2lvbnNbc3BlYy5uYW1lXTtcbiAgICAgIGZvciAodmFyIHByb3AgaW4gZXh0cykge1xuICAgICAgICBpZiAoIWV4dHMuaGFzT3duUHJvcGVydHkocHJvcCkpIGNvbnRpbnVlO1xuICAgICAgICBpZiAobW9kZU9iai5oYXNPd25Qcm9wZXJ0eShwcm9wKSkgbW9kZU9ialtcIl9cIiArIHByb3BdID0gbW9kZU9ialtwcm9wXTtcbiAgICAgICAgbW9kZU9ialtwcm9wXSA9IGV4dHNbcHJvcF07XG4gICAgICB9XG4gICAgfVxuICAgIG1vZGVPYmoubmFtZSA9IHNwZWMubmFtZTtcbiAgICBpZiAoc3BlYy5oZWxwZXJUeXBlKSBtb2RlT2JqLmhlbHBlclR5cGUgPSBzcGVjLmhlbHBlclR5cGU7XG4gICAgaWYgKHNwZWMubW9kZVByb3BzKSBmb3IgKHZhciBwcm9wIGluIHNwZWMubW9kZVByb3BzKVxuICAgICAgbW9kZU9ialtwcm9wXSA9IHNwZWMubW9kZVByb3BzW3Byb3BdO1xuXG4gICAgcmV0dXJuIG1vZGVPYmo7XG4gIH07XG5cbiAgLy8gTWluaW1hbCBkZWZhdWx0IG1vZGUuXG4gIENvZGVNaXJyb3IuZGVmaW5lTW9kZShcIm51bGxcIiwgZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHt0b2tlbjogZnVuY3Rpb24oc3RyZWFtKSB7c3RyZWFtLnNraXBUb0VuZCgpO319O1xuICB9KTtcbiAgQ29kZU1pcnJvci5kZWZpbmVNSU1FKFwidGV4dC9wbGFpblwiLCBcIm51bGxcIik7XG5cbiAgLy8gVGhpcyBjYW4gYmUgdXNlZCB0byBhdHRhY2ggcHJvcGVydGllcyB0byBtb2RlIG9iamVjdHMgZnJvbVxuICAvLyBvdXRzaWRlIHRoZSBhY3R1YWwgbW9kZSBkZWZpbml0aW9uLlxuICB2YXIgbW9kZUV4dGVuc2lvbnMgPSBDb2RlTWlycm9yLm1vZGVFeHRlbnNpb25zID0ge307XG4gIENvZGVNaXJyb3IuZXh0ZW5kTW9kZSA9IGZ1bmN0aW9uKG1vZGUsIHByb3BlcnRpZXMpIHtcbiAgICB2YXIgZXh0cyA9IG1vZGVFeHRlbnNpb25zLmhhc093blByb3BlcnR5KG1vZGUpID8gbW9kZUV4dGVuc2lvbnNbbW9kZV0gOiAobW9kZUV4dGVuc2lvbnNbbW9kZV0gPSB7fSk7XG4gICAgY29weU9iaihwcm9wZXJ0aWVzLCBleHRzKTtcbiAgfTtcblxuICAvLyBFWFRFTlNJT05TXG5cbiAgQ29kZU1pcnJvci5kZWZpbmVFeHRlbnNpb24gPSBmdW5jdGlvbihuYW1lLCBmdW5jKSB7XG4gICAgQ29kZU1pcnJvci5wcm90b3R5cGVbbmFtZV0gPSBmdW5jO1xuICB9O1xuICBDb2RlTWlycm9yLmRlZmluZURvY0V4dGVuc2lvbiA9IGZ1bmN0aW9uKG5hbWUsIGZ1bmMpIHtcbiAgICBEb2MucHJvdG90eXBlW25hbWVdID0gZnVuYztcbiAgfTtcbiAgQ29kZU1pcnJvci5kZWZpbmVPcHRpb24gPSBvcHRpb247XG5cbiAgdmFyIGluaXRIb29rcyA9IFtdO1xuICBDb2RlTWlycm9yLmRlZmluZUluaXRIb29rID0gZnVuY3Rpb24oZikge2luaXRIb29rcy5wdXNoKGYpO307XG5cbiAgdmFyIGhlbHBlcnMgPSBDb2RlTWlycm9yLmhlbHBlcnMgPSB7fTtcbiAgQ29kZU1pcnJvci5yZWdpc3RlckhlbHBlciA9IGZ1bmN0aW9uKHR5cGUsIG5hbWUsIHZhbHVlKSB7XG4gICAgaWYgKCFoZWxwZXJzLmhhc093blByb3BlcnR5KHR5cGUpKSBoZWxwZXJzW3R5cGVdID0gQ29kZU1pcnJvclt0eXBlXSA9IHtfZ2xvYmFsOiBbXX07XG4gICAgaGVscGVyc1t0eXBlXVtuYW1lXSA9IHZhbHVlO1xuICB9O1xuICBDb2RlTWlycm9yLnJlZ2lzdGVyR2xvYmFsSGVscGVyID0gZnVuY3Rpb24odHlwZSwgbmFtZSwgcHJlZGljYXRlLCB2YWx1ZSkge1xuICAgIENvZGVNaXJyb3IucmVnaXN0ZXJIZWxwZXIodHlwZSwgbmFtZSwgdmFsdWUpO1xuICAgIGhlbHBlcnNbdHlwZV0uX2dsb2JhbC5wdXNoKHtwcmVkOiBwcmVkaWNhdGUsIHZhbDogdmFsdWV9KTtcbiAgfTtcblxuICAvLyBNT0RFIFNUQVRFIEhBTkRMSU5HXG5cbiAgLy8gVXRpbGl0eSBmdW5jdGlvbnMgZm9yIHdvcmtpbmcgd2l0aCBzdGF0ZS4gRXhwb3J0ZWQgYmVjYXVzZSBuZXN0ZWRcbiAgLy8gbW9kZXMgbmVlZCB0byBkbyB0aGlzIGZvciB0aGVpciBpbm5lciBtb2Rlcy5cblxuICB2YXIgY29weVN0YXRlID0gQ29kZU1pcnJvci5jb3B5U3RhdGUgPSBmdW5jdGlvbihtb2RlLCBzdGF0ZSkge1xuICAgIGlmIChzdGF0ZSA9PT0gdHJ1ZSkgcmV0dXJuIHN0YXRlO1xuICAgIGlmIChtb2RlLmNvcHlTdGF0ZSkgcmV0dXJuIG1vZGUuY29weVN0YXRlKHN0YXRlKTtcbiAgICB2YXIgbnN0YXRlID0ge307XG4gICAgZm9yICh2YXIgbiBpbiBzdGF0ZSkge1xuICAgICAgdmFyIHZhbCA9IHN0YXRlW25dO1xuICAgICAgaWYgKHZhbCBpbnN0YW5jZW9mIEFycmF5KSB2YWwgPSB2YWwuY29uY2F0KFtdKTtcbiAgICAgIG5zdGF0ZVtuXSA9IHZhbDtcbiAgICB9XG4gICAgcmV0dXJuIG5zdGF0ZTtcbiAgfTtcblxuICB2YXIgc3RhcnRTdGF0ZSA9IENvZGVNaXJyb3Iuc3RhcnRTdGF0ZSA9IGZ1bmN0aW9uKG1vZGUsIGExLCBhMikge1xuICAgIHJldHVybiBtb2RlLnN0YXJ0U3RhdGUgPyBtb2RlLnN0YXJ0U3RhdGUoYTEsIGEyKSA6IHRydWU7XG4gIH07XG5cbiAgLy8gR2l2ZW4gYSBtb2RlIGFuZCBhIHN0YXRlIChmb3IgdGhhdCBtb2RlKSwgZmluZCB0aGUgaW5uZXIgbW9kZSBhbmRcbiAgLy8gc3RhdGUgYXQgdGhlIHBvc2l0aW9uIHRoYXQgdGhlIHN0YXRlIHJlZmVycyB0by5cbiAgQ29kZU1pcnJvci5pbm5lck1vZGUgPSBmdW5jdGlvbihtb2RlLCBzdGF0ZSkge1xuICAgIHdoaWxlIChtb2RlLmlubmVyTW9kZSkge1xuICAgICAgdmFyIGluZm8gPSBtb2RlLmlubmVyTW9kZShzdGF0ZSk7XG4gICAgICBpZiAoIWluZm8gfHwgaW5mby5tb2RlID09IG1vZGUpIGJyZWFrO1xuICAgICAgc3RhdGUgPSBpbmZvLnN0YXRlO1xuICAgICAgbW9kZSA9IGluZm8ubW9kZTtcbiAgICB9XG4gICAgcmV0dXJuIGluZm8gfHwge21vZGU6IG1vZGUsIHN0YXRlOiBzdGF0ZX07XG4gIH07XG5cbiAgLy8gU1RBTkRBUkQgQ09NTUFORFNcblxuICAvLyBDb21tYW5kcyBhcmUgcGFyYW1ldGVyLWxlc3MgYWN0aW9ucyB0aGF0IGNhbiBiZSBwZXJmb3JtZWQgb24gYW5cbiAgLy8gZWRpdG9yLCBtb3N0bHkgdXNlZCBmb3Iga2V5YmluZGluZ3MuXG4gIHZhciBjb21tYW5kcyA9IENvZGVNaXJyb3IuY29tbWFuZHMgPSB7XG4gICAgc2VsZWN0QWxsOiBmdW5jdGlvbihjbSkge2NtLnNldFNlbGVjdGlvbihQb3MoY20uZmlyc3RMaW5lKCksIDApLCBQb3MoY20ubGFzdExpbmUoKSksIHNlbF9kb250U2Nyb2xsKTt9LFxuICAgIHNpbmdsZVNlbGVjdGlvbjogZnVuY3Rpb24oY20pIHtcbiAgICAgIGNtLnNldFNlbGVjdGlvbihjbS5nZXRDdXJzb3IoXCJhbmNob3JcIiksIGNtLmdldEN1cnNvcihcImhlYWRcIiksIHNlbF9kb250U2Nyb2xsKTtcbiAgICB9LFxuICAgIGtpbGxMaW5lOiBmdW5jdGlvbihjbSkge1xuICAgICAgZGVsZXRlTmVhclNlbGVjdGlvbihjbSwgZnVuY3Rpb24ocmFuZ2UpIHtcbiAgICAgICAgaWYgKHJhbmdlLmVtcHR5KCkpIHtcbiAgICAgICAgICB2YXIgbGVuID0gZ2V0TGluZShjbS5kb2MsIHJhbmdlLmhlYWQubGluZSkudGV4dC5sZW5ndGg7XG4gICAgICAgICAgaWYgKHJhbmdlLmhlYWQuY2ggPT0gbGVuICYmIHJhbmdlLmhlYWQubGluZSA8IGNtLmxhc3RMaW5lKCkpXG4gICAgICAgICAgICByZXR1cm4ge2Zyb206IHJhbmdlLmhlYWQsIHRvOiBQb3MocmFuZ2UuaGVhZC5saW5lICsgMSwgMCl9O1xuICAgICAgICAgIGVsc2VcbiAgICAgICAgICAgIHJldHVybiB7ZnJvbTogcmFuZ2UuaGVhZCwgdG86IFBvcyhyYW5nZS5oZWFkLmxpbmUsIGxlbil9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJldHVybiB7ZnJvbTogcmFuZ2UuZnJvbSgpLCB0bzogcmFuZ2UudG8oKX07XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH0sXG4gICAgZGVsZXRlTGluZTogZnVuY3Rpb24oY20pIHtcbiAgICAgIGRlbGV0ZU5lYXJTZWxlY3Rpb24oY20sIGZ1bmN0aW9uKHJhbmdlKSB7XG4gICAgICAgIHJldHVybiB7ZnJvbTogUG9zKHJhbmdlLmZyb20oKS5saW5lLCAwKSxcbiAgICAgICAgICAgICAgICB0bzogY2xpcFBvcyhjbS5kb2MsIFBvcyhyYW5nZS50bygpLmxpbmUgKyAxLCAwKSl9O1xuICAgICAgfSk7XG4gICAgfSxcbiAgICBkZWxMaW5lTGVmdDogZnVuY3Rpb24oY20pIHtcbiAgICAgIGRlbGV0ZU5lYXJTZWxlY3Rpb24oY20sIGZ1bmN0aW9uKHJhbmdlKSB7XG4gICAgICAgIHJldHVybiB7ZnJvbTogUG9zKHJhbmdlLmZyb20oKS5saW5lLCAwKSwgdG86IHJhbmdlLmZyb20oKX07XG4gICAgICB9KTtcbiAgICB9LFxuICAgIGRlbFdyYXBwZWRMaW5lTGVmdDogZnVuY3Rpb24oY20pIHtcbiAgICAgIGRlbGV0ZU5lYXJTZWxlY3Rpb24oY20sIGZ1bmN0aW9uKHJhbmdlKSB7XG4gICAgICAgIHZhciB0b3AgPSBjbS5jaGFyQ29vcmRzKHJhbmdlLmhlYWQsIFwiZGl2XCIpLnRvcCArIDU7XG4gICAgICAgIHZhciBsZWZ0UG9zID0gY20uY29vcmRzQ2hhcih7bGVmdDogMCwgdG9wOiB0b3B9LCBcImRpdlwiKTtcbiAgICAgICAgcmV0dXJuIHtmcm9tOiBsZWZ0UG9zLCB0bzogcmFuZ2UuZnJvbSgpfTtcbiAgICAgIH0pO1xuICAgIH0sXG4gICAgZGVsV3JhcHBlZExpbmVSaWdodDogZnVuY3Rpb24oY20pIHtcbiAgICAgIGRlbGV0ZU5lYXJTZWxlY3Rpb24oY20sIGZ1bmN0aW9uKHJhbmdlKSB7XG4gICAgICAgIHZhciB0b3AgPSBjbS5jaGFyQ29vcmRzKHJhbmdlLmhlYWQsIFwiZGl2XCIpLnRvcCArIDU7XG4gICAgICAgIHZhciByaWdodFBvcyA9IGNtLmNvb3Jkc0NoYXIoe2xlZnQ6IGNtLmRpc3BsYXkubGluZURpdi5vZmZzZXRXaWR0aCArIDEwMCwgdG9wOiB0b3B9LCBcImRpdlwiKTtcbiAgICAgICAgcmV0dXJuIHtmcm9tOiByYW5nZS5mcm9tKCksIHRvOiByaWdodFBvcyB9O1xuICAgICAgfSk7XG4gICAgfSxcbiAgICB1bmRvOiBmdW5jdGlvbihjbSkge2NtLnVuZG8oKTt9LFxuICAgIHJlZG86IGZ1bmN0aW9uKGNtKSB7Y20ucmVkbygpO30sXG4gICAgdW5kb1NlbGVjdGlvbjogZnVuY3Rpb24oY20pIHtjbS51bmRvU2VsZWN0aW9uKCk7fSxcbiAgICByZWRvU2VsZWN0aW9uOiBmdW5jdGlvbihjbSkge2NtLnJlZG9TZWxlY3Rpb24oKTt9LFxuICAgIGdvRG9jU3RhcnQ6IGZ1bmN0aW9uKGNtKSB7Y20uZXh0ZW5kU2VsZWN0aW9uKFBvcyhjbS5maXJzdExpbmUoKSwgMCkpO30sXG4gICAgZ29Eb2NFbmQ6IGZ1bmN0aW9uKGNtKSB7Y20uZXh0ZW5kU2VsZWN0aW9uKFBvcyhjbS5sYXN0TGluZSgpKSk7fSxcbiAgICBnb0xpbmVTdGFydDogZnVuY3Rpb24oY20pIHtcbiAgICAgIGNtLmV4dGVuZFNlbGVjdGlvbnNCeShmdW5jdGlvbihyYW5nZSkgeyByZXR1cm4gbGluZVN0YXJ0KGNtLCByYW5nZS5oZWFkLmxpbmUpOyB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtvcmlnaW46IFwiK21vdmVcIiwgYmlhczogMX0pO1xuICAgIH0sXG4gICAgZ29MaW5lU3RhcnRTbWFydDogZnVuY3Rpb24oY20pIHtcbiAgICAgIGNtLmV4dGVuZFNlbGVjdGlvbnNCeShmdW5jdGlvbihyYW5nZSkge1xuICAgICAgICB2YXIgc3RhcnQgPSBsaW5lU3RhcnQoY20sIHJhbmdlLmhlYWQubGluZSk7XG4gICAgICAgIHZhciBsaW5lID0gY20uZ2V0TGluZUhhbmRsZShzdGFydC5saW5lKTtcbiAgICAgICAgdmFyIG9yZGVyID0gZ2V0T3JkZXIobGluZSk7XG4gICAgICAgIGlmICghb3JkZXIgfHwgb3JkZXJbMF0ubGV2ZWwgPT0gMCkge1xuICAgICAgICAgIHZhciBmaXJzdE5vbldTID0gTWF0aC5tYXgoMCwgbGluZS50ZXh0LnNlYXJjaCgvXFxTLykpO1xuICAgICAgICAgIHZhciBpbldTID0gcmFuZ2UuaGVhZC5saW5lID09IHN0YXJ0LmxpbmUgJiYgcmFuZ2UuaGVhZC5jaCA8PSBmaXJzdE5vbldTICYmIHJhbmdlLmhlYWQuY2g7XG4gICAgICAgICAgcmV0dXJuIFBvcyhzdGFydC5saW5lLCBpbldTID8gMCA6IGZpcnN0Tm9uV1MpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBzdGFydDtcbiAgICAgIH0sIHtvcmlnaW46IFwiK21vdmVcIiwgYmlhczogMX0pO1xuICAgIH0sXG4gICAgZ29MaW5lRW5kOiBmdW5jdGlvbihjbSkge1xuICAgICAgY20uZXh0ZW5kU2VsZWN0aW9uc0J5KGZ1bmN0aW9uKHJhbmdlKSB7IHJldHVybiBsaW5lRW5kKGNtLCByYW5nZS5oZWFkLmxpbmUpOyB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtvcmlnaW46IFwiK21vdmVcIiwgYmlhczogLTF9KTtcbiAgICB9LFxuICAgIGdvTGluZVJpZ2h0OiBmdW5jdGlvbihjbSkge1xuICAgICAgY20uZXh0ZW5kU2VsZWN0aW9uc0J5KGZ1bmN0aW9uKHJhbmdlKSB7XG4gICAgICAgIHZhciB0b3AgPSBjbS5jaGFyQ29vcmRzKHJhbmdlLmhlYWQsIFwiZGl2XCIpLnRvcCArIDU7XG4gICAgICAgIHJldHVybiBjbS5jb29yZHNDaGFyKHtsZWZ0OiBjbS5kaXNwbGF5LmxpbmVEaXYub2Zmc2V0V2lkdGggKyAxMDAsIHRvcDogdG9wfSwgXCJkaXZcIik7XG4gICAgICB9LCBzZWxfbW92ZSk7XG4gICAgfSxcbiAgICBnb0xpbmVMZWZ0OiBmdW5jdGlvbihjbSkge1xuICAgICAgY20uZXh0ZW5kU2VsZWN0aW9uc0J5KGZ1bmN0aW9uKHJhbmdlKSB7XG4gICAgICAgIHZhciB0b3AgPSBjbS5jaGFyQ29vcmRzKHJhbmdlLmhlYWQsIFwiZGl2XCIpLnRvcCArIDU7XG4gICAgICAgIHJldHVybiBjbS5jb29yZHNDaGFyKHtsZWZ0OiAwLCB0b3A6IHRvcH0sIFwiZGl2XCIpO1xuICAgICAgfSwgc2VsX21vdmUpO1xuICAgIH0sXG4gICAgZ29MaW5lVXA6IGZ1bmN0aW9uKGNtKSB7Y20ubW92ZVYoLTEsIFwibGluZVwiKTt9LFxuICAgIGdvTGluZURvd246IGZ1bmN0aW9uKGNtKSB7Y20ubW92ZVYoMSwgXCJsaW5lXCIpO30sXG4gICAgZ29QYWdlVXA6IGZ1bmN0aW9uKGNtKSB7Y20ubW92ZVYoLTEsIFwicGFnZVwiKTt9LFxuICAgIGdvUGFnZURvd246IGZ1bmN0aW9uKGNtKSB7Y20ubW92ZVYoMSwgXCJwYWdlXCIpO30sXG4gICAgZ29DaGFyTGVmdDogZnVuY3Rpb24oY20pIHtjbS5tb3ZlSCgtMSwgXCJjaGFyXCIpO30sXG4gICAgZ29DaGFyUmlnaHQ6IGZ1bmN0aW9uKGNtKSB7Y20ubW92ZUgoMSwgXCJjaGFyXCIpO30sXG4gICAgZ29Db2x1bW5MZWZ0OiBmdW5jdGlvbihjbSkge2NtLm1vdmVIKC0xLCBcImNvbHVtblwiKTt9LFxuICAgIGdvQ29sdW1uUmlnaHQ6IGZ1bmN0aW9uKGNtKSB7Y20ubW92ZUgoMSwgXCJjb2x1bW5cIik7fSxcbiAgICBnb1dvcmRMZWZ0OiBmdW5jdGlvbihjbSkge2NtLm1vdmVIKC0xLCBcIndvcmRcIik7fSxcbiAgICBnb0dyb3VwUmlnaHQ6IGZ1bmN0aW9uKGNtKSB7Y20ubW92ZUgoMSwgXCJncm91cFwiKTt9LFxuICAgIGdvR3JvdXBMZWZ0OiBmdW5jdGlvbihjbSkge2NtLm1vdmVIKC0xLCBcImdyb3VwXCIpO30sXG4gICAgZ29Xb3JkUmlnaHQ6IGZ1bmN0aW9uKGNtKSB7Y20ubW92ZUgoMSwgXCJ3b3JkXCIpO30sXG4gICAgZGVsQ2hhckJlZm9yZTogZnVuY3Rpb24oY20pIHtjbS5kZWxldGVIKC0xLCBcImNoYXJcIik7fSxcbiAgICBkZWxDaGFyQWZ0ZXI6IGZ1bmN0aW9uKGNtKSB7Y20uZGVsZXRlSCgxLCBcImNoYXJcIik7fSxcbiAgICBkZWxXb3JkQmVmb3JlOiBmdW5jdGlvbihjbSkge2NtLmRlbGV0ZUgoLTEsIFwid29yZFwiKTt9LFxuICAgIGRlbFdvcmRBZnRlcjogZnVuY3Rpb24oY20pIHtjbS5kZWxldGVIKDEsIFwid29yZFwiKTt9LFxuICAgIGRlbEdyb3VwQmVmb3JlOiBmdW5jdGlvbihjbSkge2NtLmRlbGV0ZUgoLTEsIFwiZ3JvdXBcIik7fSxcbiAgICBkZWxHcm91cEFmdGVyOiBmdW5jdGlvbihjbSkge2NtLmRlbGV0ZUgoMSwgXCJncm91cFwiKTt9LFxuICAgIGluZGVudEF1dG86IGZ1bmN0aW9uKGNtKSB7Y20uaW5kZW50U2VsZWN0aW9uKFwic21hcnRcIik7fSxcbiAgICBpbmRlbnRNb3JlOiBmdW5jdGlvbihjbSkge2NtLmluZGVudFNlbGVjdGlvbihcImFkZFwiKTt9LFxuICAgIGluZGVudExlc3M6IGZ1bmN0aW9uKGNtKSB7Y20uaW5kZW50U2VsZWN0aW9uKFwic3VidHJhY3RcIik7fSxcbiAgICBpbnNlcnRUYWI6IGZ1bmN0aW9uKGNtKSB7Y20ucmVwbGFjZVNlbGVjdGlvbihcIlxcdFwiKTt9LFxuICAgIGluc2VydFNvZnRUYWI6IGZ1bmN0aW9uKGNtKSB7XG4gICAgICB2YXIgc3BhY2VzID0gW10sIHJhbmdlcyA9IGNtLmxpc3RTZWxlY3Rpb25zKCksIHRhYlNpemUgPSBjbS5vcHRpb25zLnRhYlNpemU7XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHJhbmdlcy5sZW5ndGg7IGkrKykge1xuICAgICAgICB2YXIgcG9zID0gcmFuZ2VzW2ldLmZyb20oKTtcbiAgICAgICAgdmFyIGNvbCA9IGNvdW50Q29sdW1uKGNtLmdldExpbmUocG9zLmxpbmUpLCBwb3MuY2gsIHRhYlNpemUpO1xuICAgICAgICBzcGFjZXMucHVzaChuZXcgQXJyYXkodGFiU2l6ZSAtIGNvbCAlIHRhYlNpemUgKyAxKS5qb2luKFwiIFwiKSk7XG4gICAgICB9XG4gICAgICBjbS5yZXBsYWNlU2VsZWN0aW9ucyhzcGFjZXMpO1xuICAgIH0sXG4gICAgZGVmYXVsdFRhYjogZnVuY3Rpb24oY20pIHtcbiAgICAgIGlmIChjbS5zb21ldGhpbmdTZWxlY3RlZCgpKSBjbS5pbmRlbnRTZWxlY3Rpb24oXCJhZGRcIik7XG4gICAgICBlbHNlIGNtLmV4ZWNDb21tYW5kKFwiaW5zZXJ0VGFiXCIpO1xuICAgIH0sXG4gICAgdHJhbnNwb3NlQ2hhcnM6IGZ1bmN0aW9uKGNtKSB7XG4gICAgICBydW5Jbk9wKGNtLCBmdW5jdGlvbigpIHtcbiAgICAgICAgdmFyIHJhbmdlcyA9IGNtLmxpc3RTZWxlY3Rpb25zKCksIG5ld1NlbCA9IFtdO1xuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHJhbmdlcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgIHZhciBjdXIgPSByYW5nZXNbaV0uaGVhZCwgbGluZSA9IGdldExpbmUoY20uZG9jLCBjdXIubGluZSkudGV4dDtcbiAgICAgICAgICBpZiAobGluZSkge1xuICAgICAgICAgICAgaWYgKGN1ci5jaCA9PSBsaW5lLmxlbmd0aCkgY3VyID0gbmV3IFBvcyhjdXIubGluZSwgY3VyLmNoIC0gMSk7XG4gICAgICAgICAgICBpZiAoY3VyLmNoID4gMCkge1xuICAgICAgICAgICAgICBjdXIgPSBuZXcgUG9zKGN1ci5saW5lLCBjdXIuY2ggKyAxKTtcbiAgICAgICAgICAgICAgY20ucmVwbGFjZVJhbmdlKGxpbmUuY2hhckF0KGN1ci5jaCAtIDEpICsgbGluZS5jaGFyQXQoY3VyLmNoIC0gMiksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBQb3MoY3VyLmxpbmUsIGN1ci5jaCAtIDIpLCBjdXIsIFwiK3RyYW5zcG9zZVwiKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoY3VyLmxpbmUgPiBjbS5kb2MuZmlyc3QpIHtcbiAgICAgICAgICAgICAgdmFyIHByZXYgPSBnZXRMaW5lKGNtLmRvYywgY3VyLmxpbmUgLSAxKS50ZXh0O1xuICAgICAgICAgICAgICBpZiAocHJldilcbiAgICAgICAgICAgICAgICBjbS5yZXBsYWNlUmFuZ2UobGluZS5jaGFyQXQoMCkgKyBcIlxcblwiICsgcHJldi5jaGFyQXQocHJldi5sZW5ndGggLSAxKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgUG9zKGN1ci5saW5lIC0gMSwgcHJldi5sZW5ndGggLSAxKSwgUG9zKGN1ci5saW5lLCAxKSwgXCIrdHJhbnNwb3NlXCIpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBuZXdTZWwucHVzaChuZXcgUmFuZ2UoY3VyLCBjdXIpKTtcbiAgICAgICAgfVxuICAgICAgICBjbS5zZXRTZWxlY3Rpb25zKG5ld1NlbCk7XG4gICAgICB9KTtcbiAgICB9LFxuICAgIG5ld2xpbmVBbmRJbmRlbnQ6IGZ1bmN0aW9uKGNtKSB7XG4gICAgICBydW5Jbk9wKGNtLCBmdW5jdGlvbigpIHtcbiAgICAgICAgdmFyIGxlbiA9IGNtLmxpc3RTZWxlY3Rpb25zKCkubGVuZ3RoO1xuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbjsgaSsrKSB7XG4gICAgICAgICAgdmFyIHJhbmdlID0gY20ubGlzdFNlbGVjdGlvbnMoKVtpXTtcbiAgICAgICAgICBjbS5yZXBsYWNlUmFuZ2UoXCJcXG5cIiwgcmFuZ2UuYW5jaG9yLCByYW5nZS5oZWFkLCBcIitpbnB1dFwiKTtcbiAgICAgICAgICBjbS5pbmRlbnRMaW5lKHJhbmdlLmZyb20oKS5saW5lICsgMSwgbnVsbCwgdHJ1ZSk7XG4gICAgICAgICAgZW5zdXJlQ3Vyc29yVmlzaWJsZShjbSk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH0sXG4gICAgdG9nZ2xlT3ZlcndyaXRlOiBmdW5jdGlvbihjbSkge2NtLnRvZ2dsZU92ZXJ3cml0ZSgpO31cbiAgfTtcblxuICAvLyBTVEFOREFSRCBLRVlNQVBTXG5cbiAgdmFyIGtleU1hcCA9IENvZGVNaXJyb3Iua2V5TWFwID0ge307XG4gIGtleU1hcC5iYXNpYyA9IHtcbiAgICBcIkxlZnRcIjogXCJnb0NoYXJMZWZ0XCIsIFwiUmlnaHRcIjogXCJnb0NoYXJSaWdodFwiLCBcIlVwXCI6IFwiZ29MaW5lVXBcIiwgXCJEb3duXCI6IFwiZ29MaW5lRG93blwiLFxuICAgIFwiRW5kXCI6IFwiZ29MaW5lRW5kXCIsIFwiSG9tZVwiOiBcImdvTGluZVN0YXJ0U21hcnRcIiwgXCJQYWdlVXBcIjogXCJnb1BhZ2VVcFwiLCBcIlBhZ2VEb3duXCI6IFwiZ29QYWdlRG93blwiLFxuICAgIFwiRGVsZXRlXCI6IFwiZGVsQ2hhckFmdGVyXCIsIFwiQmFja3NwYWNlXCI6IFwiZGVsQ2hhckJlZm9yZVwiLCBcIlNoaWZ0LUJhY2tzcGFjZVwiOiBcImRlbENoYXJCZWZvcmVcIixcbiAgICBcIlRhYlwiOiBcImRlZmF1bHRUYWJcIiwgXCJTaGlmdC1UYWJcIjogXCJpbmRlbnRBdXRvXCIsXG4gICAgXCJFbnRlclwiOiBcIm5ld2xpbmVBbmRJbmRlbnRcIiwgXCJJbnNlcnRcIjogXCJ0b2dnbGVPdmVyd3JpdGVcIixcbiAgICBcIkVzY1wiOiBcInNpbmdsZVNlbGVjdGlvblwiXG4gIH07XG4gIC8vIE5vdGUgdGhhdCB0aGUgc2F2ZSBhbmQgZmluZC1yZWxhdGVkIGNvbW1hbmRzIGFyZW4ndCBkZWZpbmVkIGJ5XG4gIC8vIGRlZmF1bHQuIFVzZXIgY29kZSBvciBhZGRvbnMgY2FuIGRlZmluZSB0aGVtLiBVbmtub3duIGNvbW1hbmRzXG4gIC8vIGFyZSBzaW1wbHkgaWdub3JlZC5cbiAga2V5TWFwLnBjRGVmYXVsdCA9IHtcbiAgICBcIkN0cmwtQVwiOiBcInNlbGVjdEFsbFwiLCBcIkN0cmwtRFwiOiBcImRlbGV0ZUxpbmVcIiwgXCJDdHJsLVpcIjogXCJ1bmRvXCIsIFwiU2hpZnQtQ3RybC1aXCI6IFwicmVkb1wiLCBcIkN0cmwtWVwiOiBcInJlZG9cIixcbiAgICBcIkN0cmwtSG9tZVwiOiBcImdvRG9jU3RhcnRcIiwgXCJDdHJsLVVwXCI6IFwiZ29Eb2NTdGFydFwiLCBcIkN0cmwtRW5kXCI6IFwiZ29Eb2NFbmRcIiwgXCJDdHJsLURvd25cIjogXCJnb0RvY0VuZFwiLFxuICAgIFwiQ3RybC1MZWZ0XCI6IFwiZ29Hcm91cExlZnRcIiwgXCJDdHJsLVJpZ2h0XCI6IFwiZ29Hcm91cFJpZ2h0XCIsIFwiQWx0LUxlZnRcIjogXCJnb0xpbmVTdGFydFwiLCBcIkFsdC1SaWdodFwiOiBcImdvTGluZUVuZFwiLFxuICAgIFwiQ3RybC1CYWNrc3BhY2VcIjogXCJkZWxHcm91cEJlZm9yZVwiLCBcIkN0cmwtRGVsZXRlXCI6IFwiZGVsR3JvdXBBZnRlclwiLCBcIkN0cmwtU1wiOiBcInNhdmVcIiwgXCJDdHJsLUZcIjogXCJmaW5kXCIsXG4gICAgXCJDdHJsLUdcIjogXCJmaW5kTmV4dFwiLCBcIlNoaWZ0LUN0cmwtR1wiOiBcImZpbmRQcmV2XCIsIFwiU2hpZnQtQ3RybC1GXCI6IFwicmVwbGFjZVwiLCBcIlNoaWZ0LUN0cmwtUlwiOiBcInJlcGxhY2VBbGxcIixcbiAgICBcIkN0cmwtW1wiOiBcImluZGVudExlc3NcIiwgXCJDdHJsLV1cIjogXCJpbmRlbnRNb3JlXCIsXG4gICAgXCJDdHJsLVVcIjogXCJ1bmRvU2VsZWN0aW9uXCIsIFwiU2hpZnQtQ3RybC1VXCI6IFwicmVkb1NlbGVjdGlvblwiLCBcIkFsdC1VXCI6IFwicmVkb1NlbGVjdGlvblwiLFxuICAgIGZhbGx0aHJvdWdoOiBcImJhc2ljXCJcbiAgfTtcbiAga2V5TWFwLm1hY0RlZmF1bHQgPSB7XG4gICAgXCJDbWQtQVwiOiBcInNlbGVjdEFsbFwiLCBcIkNtZC1EXCI6IFwiZGVsZXRlTGluZVwiLCBcIkNtZC1aXCI6IFwidW5kb1wiLCBcIlNoaWZ0LUNtZC1aXCI6IFwicmVkb1wiLCBcIkNtZC1ZXCI6IFwicmVkb1wiLFxuICAgIFwiQ21kLUhvbWVcIjogXCJnb0RvY1N0YXJ0XCIsIFwiQ21kLVVwXCI6IFwiZ29Eb2NTdGFydFwiLCBcIkNtZC1FbmRcIjogXCJnb0RvY0VuZFwiLCBcIkNtZC1Eb3duXCI6IFwiZ29Eb2NFbmRcIiwgXCJBbHQtTGVmdFwiOiBcImdvR3JvdXBMZWZ0XCIsXG4gICAgXCJBbHQtUmlnaHRcIjogXCJnb0dyb3VwUmlnaHRcIiwgXCJDbWQtTGVmdFwiOiBcImdvTGluZUxlZnRcIiwgXCJDbWQtUmlnaHRcIjogXCJnb0xpbmVSaWdodFwiLCBcIkFsdC1CYWNrc3BhY2VcIjogXCJkZWxHcm91cEJlZm9yZVwiLFxuICAgIFwiQ3RybC1BbHQtQmFja3NwYWNlXCI6IFwiZGVsR3JvdXBBZnRlclwiLCBcIkFsdC1EZWxldGVcIjogXCJkZWxHcm91cEFmdGVyXCIsIFwiQ21kLVNcIjogXCJzYXZlXCIsIFwiQ21kLUZcIjogXCJmaW5kXCIsXG4gICAgXCJDbWQtR1wiOiBcImZpbmROZXh0XCIsIFwiU2hpZnQtQ21kLUdcIjogXCJmaW5kUHJldlwiLCBcIkNtZC1BbHQtRlwiOiBcInJlcGxhY2VcIiwgXCJTaGlmdC1DbWQtQWx0LUZcIjogXCJyZXBsYWNlQWxsXCIsXG4gICAgXCJDbWQtW1wiOiBcImluZGVudExlc3NcIiwgXCJDbWQtXVwiOiBcImluZGVudE1vcmVcIiwgXCJDbWQtQmFja3NwYWNlXCI6IFwiZGVsV3JhcHBlZExpbmVMZWZ0XCIsIFwiQ21kLURlbGV0ZVwiOiBcImRlbFdyYXBwZWRMaW5lUmlnaHRcIixcbiAgICBcIkNtZC1VXCI6IFwidW5kb1NlbGVjdGlvblwiLCBcIlNoaWZ0LUNtZC1VXCI6IFwicmVkb1NlbGVjdGlvblwiLFxuICAgIGZhbGx0aHJvdWdoOiBbXCJiYXNpY1wiLCBcImVtYWNzeVwiXVxuICB9O1xuICAvLyBWZXJ5IGJhc2ljIHJlYWRsaW5lL2VtYWNzLXN0eWxlIGJpbmRpbmdzLCB3aGljaCBhcmUgc3RhbmRhcmQgb24gTWFjLlxuICBrZXlNYXAuZW1hY3N5ID0ge1xuICAgIFwiQ3RybC1GXCI6IFwiZ29DaGFyUmlnaHRcIiwgXCJDdHJsLUJcIjogXCJnb0NoYXJMZWZ0XCIsIFwiQ3RybC1QXCI6IFwiZ29MaW5lVXBcIiwgXCJDdHJsLU5cIjogXCJnb0xpbmVEb3duXCIsXG4gICAgXCJBbHQtRlwiOiBcImdvV29yZFJpZ2h0XCIsIFwiQWx0LUJcIjogXCJnb1dvcmRMZWZ0XCIsIFwiQ3RybC1BXCI6IFwiZ29MaW5lU3RhcnRcIiwgXCJDdHJsLUVcIjogXCJnb0xpbmVFbmRcIixcbiAgICBcIkN0cmwtVlwiOiBcImdvUGFnZURvd25cIiwgXCJTaGlmdC1DdHJsLVZcIjogXCJnb1BhZ2VVcFwiLCBcIkN0cmwtRFwiOiBcImRlbENoYXJBZnRlclwiLCBcIkN0cmwtSFwiOiBcImRlbENoYXJCZWZvcmVcIixcbiAgICBcIkFsdC1EXCI6IFwiZGVsV29yZEFmdGVyXCIsIFwiQWx0LUJhY2tzcGFjZVwiOiBcImRlbFdvcmRCZWZvcmVcIiwgXCJDdHJsLUtcIjogXCJraWxsTGluZVwiLCBcIkN0cmwtVFwiOiBcInRyYW5zcG9zZUNoYXJzXCJcbiAgfTtcbiAga2V5TWFwW1wiZGVmYXVsdFwiXSA9IG1hYyA/IGtleU1hcC5tYWNEZWZhdWx0IDoga2V5TWFwLnBjRGVmYXVsdDtcblxuICAvLyBLRVlNQVAgRElTUEFUQ0hcblxuICBmdW5jdGlvbiBnZXRLZXlNYXAodmFsKSB7XG4gICAgaWYgKHR5cGVvZiB2YWwgPT0gXCJzdHJpbmdcIikgcmV0dXJuIGtleU1hcFt2YWxdO1xuICAgIGVsc2UgcmV0dXJuIHZhbDtcbiAgfVxuXG4gIC8vIEdpdmVuIGFuIGFycmF5IG9mIGtleW1hcHMgYW5kIGEga2V5IG5hbWUsIGNhbGwgaGFuZGxlIG9uIGFueVxuICAvLyBiaW5kaW5ncyBmb3VuZCwgdW50aWwgdGhhdCByZXR1cm5zIGEgdHJ1dGh5IHZhbHVlLCBhdCB3aGljaCBwb2ludFxuICAvLyB3ZSBjb25zaWRlciB0aGUga2V5IGhhbmRsZWQuIEltcGxlbWVudHMgdGhpbmdzIGxpa2UgYmluZGluZyBhIGtleVxuICAvLyB0byBmYWxzZSBzdG9wcGluZyBmdXJ0aGVyIGhhbmRsaW5nIGFuZCBrZXltYXAgZmFsbHRocm91Z2guXG4gIHZhciBsb29rdXBLZXkgPSBDb2RlTWlycm9yLmxvb2t1cEtleSA9IGZ1bmN0aW9uKG5hbWUsIG1hcHMsIGhhbmRsZSkge1xuICAgIGZ1bmN0aW9uIGxvb2t1cChtYXApIHtcbiAgICAgIG1hcCA9IGdldEtleU1hcChtYXApO1xuICAgICAgdmFyIGZvdW5kID0gbWFwW25hbWVdO1xuICAgICAgaWYgKGZvdW5kID09PSBmYWxzZSkgcmV0dXJuIFwic3RvcFwiO1xuICAgICAgaWYgKGZvdW5kICE9IG51bGwgJiYgaGFuZGxlKGZvdW5kKSkgcmV0dXJuIHRydWU7XG4gICAgICBpZiAobWFwLm5vZmFsbHRocm91Z2gpIHJldHVybiBcInN0b3BcIjtcblxuICAgICAgdmFyIGZhbGx0aHJvdWdoID0gbWFwLmZhbGx0aHJvdWdoO1xuICAgICAgaWYgKGZhbGx0aHJvdWdoID09IG51bGwpIHJldHVybiBmYWxzZTtcbiAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwoZmFsbHRocm91Z2gpICE9IFwiW29iamVjdCBBcnJheV1cIilcbiAgICAgICAgcmV0dXJuIGxvb2t1cChmYWxsdGhyb3VnaCk7XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZhbGx0aHJvdWdoLmxlbmd0aDsgKytpKSB7XG4gICAgICAgIHZhciBkb25lID0gbG9va3VwKGZhbGx0aHJvdWdoW2ldKTtcbiAgICAgICAgaWYgKGRvbmUpIHJldHVybiBkb25lO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbWFwcy5sZW5ndGg7ICsraSkge1xuICAgICAgdmFyIGRvbmUgPSBsb29rdXAobWFwc1tpXSk7XG4gICAgICBpZiAoZG9uZSkgcmV0dXJuIGRvbmUgIT0gXCJzdG9wXCI7XG4gICAgfVxuICB9O1xuXG4gIC8vIE1vZGlmaWVyIGtleSBwcmVzc2VzIGRvbid0IGNvdW50IGFzICdyZWFsJyBrZXkgcHJlc3NlcyBmb3IgdGhlXG4gIC8vIHB1cnBvc2Ugb2Yga2V5bWFwIGZhbGx0aHJvdWdoLlxuICB2YXIgaXNNb2RpZmllcktleSA9IENvZGVNaXJyb3IuaXNNb2RpZmllcktleSA9IGZ1bmN0aW9uKGV2ZW50KSB7XG4gICAgdmFyIG5hbWUgPSBrZXlOYW1lc1tldmVudC5rZXlDb2RlXTtcbiAgICByZXR1cm4gbmFtZSA9PSBcIkN0cmxcIiB8fCBuYW1lID09IFwiQWx0XCIgfHwgbmFtZSA9PSBcIlNoaWZ0XCIgfHwgbmFtZSA9PSBcIk1vZFwiO1xuICB9O1xuXG4gIC8vIExvb2sgdXAgdGhlIG5hbWUgb2YgYSBrZXkgYXMgaW5kaWNhdGVkIGJ5IGFuIGV2ZW50IG9iamVjdC5cbiAgdmFyIGtleU5hbWUgPSBDb2RlTWlycm9yLmtleU5hbWUgPSBmdW5jdGlvbihldmVudCwgbm9TaGlmdCkge1xuICAgIGlmIChwcmVzdG8gJiYgZXZlbnQua2V5Q29kZSA9PSAzNCAmJiBldmVudFtcImNoYXJcIl0pIHJldHVybiBmYWxzZTtcbiAgICB2YXIgbmFtZSA9IGtleU5hbWVzW2V2ZW50LmtleUNvZGVdO1xuICAgIGlmIChuYW1lID09IG51bGwgfHwgZXZlbnQuYWx0R3JhcGhLZXkpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoZXZlbnQuYWx0S2V5KSBuYW1lID0gXCJBbHQtXCIgKyBuYW1lO1xuICAgIGlmIChmbGlwQ3RybENtZCA/IGV2ZW50Lm1ldGFLZXkgOiBldmVudC5jdHJsS2V5KSBuYW1lID0gXCJDdHJsLVwiICsgbmFtZTtcbiAgICBpZiAoZmxpcEN0cmxDbWQgPyBldmVudC5jdHJsS2V5IDogZXZlbnQubWV0YUtleSkgbmFtZSA9IFwiQ21kLVwiICsgbmFtZTtcbiAgICBpZiAoIW5vU2hpZnQgJiYgZXZlbnQuc2hpZnRLZXkpIG5hbWUgPSBcIlNoaWZ0LVwiICsgbmFtZTtcbiAgICByZXR1cm4gbmFtZTtcbiAgfTtcblxuICAvLyBGUk9NVEVYVEFSRUFcblxuICBDb2RlTWlycm9yLmZyb21UZXh0QXJlYSA9IGZ1bmN0aW9uKHRleHRhcmVhLCBvcHRpb25zKSB7XG4gICAgaWYgKCFvcHRpb25zKSBvcHRpb25zID0ge307XG4gICAgb3B0aW9ucy52YWx1ZSA9IHRleHRhcmVhLnZhbHVlO1xuICAgIGlmICghb3B0aW9ucy50YWJpbmRleCAmJiB0ZXh0YXJlYS50YWJpbmRleClcbiAgICAgIG9wdGlvbnMudGFiaW5kZXggPSB0ZXh0YXJlYS50YWJpbmRleDtcbiAgICBpZiAoIW9wdGlvbnMucGxhY2Vob2xkZXIgJiYgdGV4dGFyZWEucGxhY2Vob2xkZXIpXG4gICAgICBvcHRpb25zLnBsYWNlaG9sZGVyID0gdGV4dGFyZWEucGxhY2Vob2xkZXI7XG4gICAgLy8gU2V0IGF1dG9mb2N1cyB0byB0cnVlIGlmIHRoaXMgdGV4dGFyZWEgaXMgZm9jdXNlZCwgb3IgaWYgaXQgaGFzXG4gICAgLy8gYXV0b2ZvY3VzIGFuZCBubyBvdGhlciBlbGVtZW50IGlzIGZvY3VzZWQuXG4gICAgaWYgKG9wdGlvbnMuYXV0b2ZvY3VzID09IG51bGwpIHtcbiAgICAgIHZhciBoYXNGb2N1cyA9IGFjdGl2ZUVsdCgpO1xuICAgICAgb3B0aW9ucy5hdXRvZm9jdXMgPSBoYXNGb2N1cyA9PSB0ZXh0YXJlYSB8fFxuICAgICAgICB0ZXh0YXJlYS5nZXRBdHRyaWJ1dGUoXCJhdXRvZm9jdXNcIikgIT0gbnVsbCAmJiBoYXNGb2N1cyA9PSBkb2N1bWVudC5ib2R5O1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHNhdmUoKSB7dGV4dGFyZWEudmFsdWUgPSBjbS5nZXRWYWx1ZSgpO31cbiAgICBpZiAodGV4dGFyZWEuZm9ybSkge1xuICAgICAgb24odGV4dGFyZWEuZm9ybSwgXCJzdWJtaXRcIiwgc2F2ZSk7XG4gICAgICAvLyBEZXBsb3JhYmxlIGhhY2sgdG8gbWFrZSB0aGUgc3VibWl0IG1ldGhvZCBkbyB0aGUgcmlnaHQgdGhpbmcuXG4gICAgICBpZiAoIW9wdGlvbnMubGVhdmVTdWJtaXRNZXRob2RBbG9uZSkge1xuICAgICAgICB2YXIgZm9ybSA9IHRleHRhcmVhLmZvcm0sIHJlYWxTdWJtaXQgPSBmb3JtLnN1Ym1pdDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICB2YXIgd3JhcHBlZFN1Ym1pdCA9IGZvcm0uc3VibWl0ID0gZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICBzYXZlKCk7XG4gICAgICAgICAgICBmb3JtLnN1Ym1pdCA9IHJlYWxTdWJtaXQ7XG4gICAgICAgICAgICBmb3JtLnN1Ym1pdCgpO1xuICAgICAgICAgICAgZm9ybS5zdWJtaXQgPSB3cmFwcGVkU3VibWl0O1xuICAgICAgICAgIH07XG4gICAgICAgIH0gY2F0Y2goZSkge31cbiAgICAgIH1cbiAgICB9XG5cbiAgICB0ZXh0YXJlYS5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gICAgdmFyIGNtID0gQ29kZU1pcnJvcihmdW5jdGlvbihub2RlKSB7XG4gICAgICB0ZXh0YXJlYS5wYXJlbnROb2RlLmluc2VydEJlZm9yZShub2RlLCB0ZXh0YXJlYS5uZXh0U2libGluZyk7XG4gICAgfSwgb3B0aW9ucyk7XG4gICAgY20uc2F2ZSA9IHNhdmU7XG4gICAgY20uZ2V0VGV4dEFyZWEgPSBmdW5jdGlvbigpIHsgcmV0dXJuIHRleHRhcmVhOyB9O1xuICAgIGNtLnRvVGV4dEFyZWEgPSBmdW5jdGlvbigpIHtcbiAgICAgIHNhdmUoKTtcbiAgICAgIHRleHRhcmVhLnBhcmVudE5vZGUucmVtb3ZlQ2hpbGQoY20uZ2V0V3JhcHBlckVsZW1lbnQoKSk7XG4gICAgICB0ZXh0YXJlYS5zdHlsZS5kaXNwbGF5ID0gXCJcIjtcbiAgICAgIGlmICh0ZXh0YXJlYS5mb3JtKSB7XG4gICAgICAgIG9mZih0ZXh0YXJlYS5mb3JtLCBcInN1Ym1pdFwiLCBzYXZlKTtcbiAgICAgICAgaWYgKHR5cGVvZiB0ZXh0YXJlYS5mb3JtLnN1Ym1pdCA9PSBcImZ1bmN0aW9uXCIpXG4gICAgICAgICAgdGV4dGFyZWEuZm9ybS5zdWJtaXQgPSByZWFsU3VibWl0O1xuICAgICAgfVxuICAgIH07XG4gICAgcmV0dXJuIGNtO1xuICB9O1xuXG4gIC8vIFNUUklORyBTVFJFQU1cblxuICAvLyBGZWQgdG8gdGhlIG1vZGUgcGFyc2VycywgcHJvdmlkZXMgaGVscGVyIGZ1bmN0aW9ucyB0byBtYWtlXG4gIC8vIHBhcnNlcnMgbW9yZSBzdWNjaW5jdC5cblxuICB2YXIgU3RyaW5nU3RyZWFtID0gQ29kZU1pcnJvci5TdHJpbmdTdHJlYW0gPSBmdW5jdGlvbihzdHJpbmcsIHRhYlNpemUpIHtcbiAgICB0aGlzLnBvcyA9IHRoaXMuc3RhcnQgPSAwO1xuICAgIHRoaXMuc3RyaW5nID0gc3RyaW5nO1xuICAgIHRoaXMudGFiU2l6ZSA9IHRhYlNpemUgfHwgODtcbiAgICB0aGlzLmxhc3RDb2x1bW5Qb3MgPSB0aGlzLmxhc3RDb2x1bW5WYWx1ZSA9IDA7XG4gICAgdGhpcy5saW5lU3RhcnQgPSAwO1xuICB9O1xuXG4gIFN0cmluZ1N0cmVhbS5wcm90b3R5cGUgPSB7XG4gICAgZW9sOiBmdW5jdGlvbigpIHtyZXR1cm4gdGhpcy5wb3MgPj0gdGhpcy5zdHJpbmcubGVuZ3RoO30sXG4gICAgc29sOiBmdW5jdGlvbigpIHtyZXR1cm4gdGhpcy5wb3MgPT0gdGhpcy5saW5lU3RhcnQ7fSxcbiAgICBwZWVrOiBmdW5jdGlvbigpIHtyZXR1cm4gdGhpcy5zdHJpbmcuY2hhckF0KHRoaXMucG9zKSB8fCB1bmRlZmluZWQ7fSxcbiAgICBuZXh0OiBmdW5jdGlvbigpIHtcbiAgICAgIGlmICh0aGlzLnBvcyA8IHRoaXMuc3RyaW5nLmxlbmd0aClcbiAgICAgICAgcmV0dXJuIHRoaXMuc3RyaW5nLmNoYXJBdCh0aGlzLnBvcysrKTtcbiAgICB9LFxuICAgIGVhdDogZnVuY3Rpb24obWF0Y2gpIHtcbiAgICAgIHZhciBjaCA9IHRoaXMuc3RyaW5nLmNoYXJBdCh0aGlzLnBvcyk7XG4gICAgICBpZiAodHlwZW9mIG1hdGNoID09IFwic3RyaW5nXCIpIHZhciBvayA9IGNoID09IG1hdGNoO1xuICAgICAgZWxzZSB2YXIgb2sgPSBjaCAmJiAobWF0Y2gudGVzdCA/IG1hdGNoLnRlc3QoY2gpIDogbWF0Y2goY2gpKTtcbiAgICAgIGlmIChvaykgeysrdGhpcy5wb3M7IHJldHVybiBjaDt9XG4gICAgfSxcbiAgICBlYXRXaGlsZTogZnVuY3Rpb24obWF0Y2gpIHtcbiAgICAgIHZhciBzdGFydCA9IHRoaXMucG9zO1xuICAgICAgd2hpbGUgKHRoaXMuZWF0KG1hdGNoKSl7fVxuICAgICAgcmV0dXJuIHRoaXMucG9zID4gc3RhcnQ7XG4gICAgfSxcbiAgICBlYXRTcGFjZTogZnVuY3Rpb24oKSB7XG4gICAgICB2YXIgc3RhcnQgPSB0aGlzLnBvcztcbiAgICAgIHdoaWxlICgvW1xcc1xcdTAwYTBdLy50ZXN0KHRoaXMuc3RyaW5nLmNoYXJBdCh0aGlzLnBvcykpKSArK3RoaXMucG9zO1xuICAgICAgcmV0dXJuIHRoaXMucG9zID4gc3RhcnQ7XG4gICAgfSxcbiAgICBza2lwVG9FbmQ6IGZ1bmN0aW9uKCkge3RoaXMucG9zID0gdGhpcy5zdHJpbmcubGVuZ3RoO30sXG4gICAgc2tpcFRvOiBmdW5jdGlvbihjaCkge1xuICAgICAgdmFyIGZvdW5kID0gdGhpcy5zdHJpbmcuaW5kZXhPZihjaCwgdGhpcy5wb3MpO1xuICAgICAgaWYgKGZvdW5kID4gLTEpIHt0aGlzLnBvcyA9IGZvdW5kOyByZXR1cm4gdHJ1ZTt9XG4gICAgfSxcbiAgICBiYWNrVXA6IGZ1bmN0aW9uKG4pIHt0aGlzLnBvcyAtPSBuO30sXG4gICAgY29sdW1uOiBmdW5jdGlvbigpIHtcbiAgICAgIGlmICh0aGlzLmxhc3RDb2x1bW5Qb3MgPCB0aGlzLnN0YXJ0KSB7XG4gICAgICAgIHRoaXMubGFzdENvbHVtblZhbHVlID0gY291bnRDb2x1bW4odGhpcy5zdHJpbmcsIHRoaXMuc3RhcnQsIHRoaXMudGFiU2l6ZSwgdGhpcy5sYXN0Q29sdW1uUG9zLCB0aGlzLmxhc3RDb2x1bW5WYWx1ZSk7XG4gICAgICAgIHRoaXMubGFzdENvbHVtblBvcyA9IHRoaXMuc3RhcnQ7XG4gICAgICB9XG4gICAgICByZXR1cm4gdGhpcy5sYXN0Q29sdW1uVmFsdWUgLSAodGhpcy5saW5lU3RhcnQgPyBjb3VudENvbHVtbih0aGlzLnN0cmluZywgdGhpcy5saW5lU3RhcnQsIHRoaXMudGFiU2l6ZSkgOiAwKTtcbiAgICB9LFxuICAgIGluZGVudGF0aW9uOiBmdW5jdGlvbigpIHtcbiAgICAgIHJldHVybiBjb3VudENvbHVtbih0aGlzLnN0cmluZywgbnVsbCwgdGhpcy50YWJTaXplKSAtXG4gICAgICAgICh0aGlzLmxpbmVTdGFydCA/IGNvdW50Q29sdW1uKHRoaXMuc3RyaW5nLCB0aGlzLmxpbmVTdGFydCwgdGhpcy50YWJTaXplKSA6IDApO1xuICAgIH0sXG4gICAgbWF0Y2g6IGZ1bmN0aW9uKHBhdHRlcm4sIGNvbnN1bWUsIGNhc2VJbnNlbnNpdGl2ZSkge1xuICAgICAgaWYgKHR5cGVvZiBwYXR0ZXJuID09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgdmFyIGNhc2VkID0gZnVuY3Rpb24oc3RyKSB7cmV0dXJuIGNhc2VJbnNlbnNpdGl2ZSA/IHN0ci50b0xvd2VyQ2FzZSgpIDogc3RyO307XG4gICAgICAgIHZhciBzdWJzdHIgPSB0aGlzLnN0cmluZy5zdWJzdHIodGhpcy5wb3MsIHBhdHRlcm4ubGVuZ3RoKTtcbiAgICAgICAgaWYgKGNhc2VkKHN1YnN0cikgPT0gY2FzZWQocGF0dGVybikpIHtcbiAgICAgICAgICBpZiAoY29uc3VtZSAhPT0gZmFsc2UpIHRoaXMucG9zICs9IHBhdHRlcm4ubGVuZ3RoO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB2YXIgbWF0Y2ggPSB0aGlzLnN0cmluZy5zbGljZSh0aGlzLnBvcykubWF0Y2gocGF0dGVybik7XG4gICAgICAgIGlmIChtYXRjaCAmJiBtYXRjaC5pbmRleCA+IDApIHJldHVybiBudWxsO1xuICAgICAgICBpZiAobWF0Y2ggJiYgY29uc3VtZSAhPT0gZmFsc2UpIHRoaXMucG9zICs9IG1hdGNoWzBdLmxlbmd0aDtcbiAgICAgICAgcmV0dXJuIG1hdGNoO1xuICAgICAgfVxuICAgIH0sXG4gICAgY3VycmVudDogZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5zdHJpbmcuc2xpY2UodGhpcy5zdGFydCwgdGhpcy5wb3MpO30sXG4gICAgaGlkZUZpcnN0Q2hhcnM6IGZ1bmN0aW9uKG4sIGlubmVyKSB7XG4gICAgICB0aGlzLmxpbmVTdGFydCArPSBuO1xuICAgICAgdHJ5IHsgcmV0dXJuIGlubmVyKCk7IH1cbiAgICAgIGZpbmFsbHkgeyB0aGlzLmxpbmVTdGFydCAtPSBuOyB9XG4gICAgfVxuICB9O1xuXG4gIC8vIFRFWFRNQVJLRVJTXG5cbiAgLy8gQ3JlYXRlZCB3aXRoIG1hcmtUZXh0IGFuZCBzZXRCb29rbWFyayBtZXRob2RzLiBBIFRleHRNYXJrZXIgaXMgYVxuICAvLyBoYW5kbGUgdGhhdCBjYW4gYmUgdXNlZCB0byBjbGVhciBvciBmaW5kIGEgbWFya2VkIHBvc2l0aW9uIGluIHRoZVxuICAvLyBkb2N1bWVudC4gTGluZSBvYmplY3RzIGhvbGQgYXJyYXlzIChtYXJrZWRTcGFucykgY29udGFpbmluZ1xuICAvLyB7ZnJvbSwgdG8sIG1hcmtlcn0gb2JqZWN0IHBvaW50aW5nIHRvIHN1Y2ggbWFya2VyIG9iamVjdHMsIGFuZFxuICAvLyBpbmRpY2F0aW5nIHRoYXQgc3VjaCBhIG1hcmtlciBpcyBwcmVzZW50IG9uIHRoYXQgbGluZS4gTXVsdGlwbGVcbiAgLy8gbGluZXMgbWF5IHBvaW50IHRvIHRoZSBzYW1lIG1hcmtlciB3aGVuIGl0IHNwYW5zIGFjcm9zcyBsaW5lcy5cbiAgLy8gVGhlIHNwYW5zIHdpbGwgaGF2ZSBudWxsIGZvciB0aGVpciBmcm9tL3RvIHByb3BlcnRpZXMgd2hlbiB0aGVcbiAgLy8gbWFya2VyIGNvbnRpbnVlcyBiZXlvbmQgdGhlIHN0YXJ0L2VuZCBvZiB0aGUgbGluZS4gTWFya2VycyBoYXZlXG4gIC8vIGxpbmtzIGJhY2sgdG8gdGhlIGxpbmVzIHRoZXkgY3VycmVudGx5IHRvdWNoLlxuXG4gIHZhciBUZXh0TWFya2VyID0gQ29kZU1pcnJvci5UZXh0TWFya2VyID0gZnVuY3Rpb24oZG9jLCB0eXBlKSB7XG4gICAgdGhpcy5saW5lcyA9IFtdO1xuICAgIHRoaXMudHlwZSA9IHR5cGU7XG4gICAgdGhpcy5kb2MgPSBkb2M7XG4gIH07XG4gIGV2ZW50TWl4aW4oVGV4dE1hcmtlcik7XG5cbiAgLy8gQ2xlYXIgdGhlIG1hcmtlci5cbiAgVGV4dE1hcmtlci5wcm90b3R5cGUuY2xlYXIgPSBmdW5jdGlvbigpIHtcbiAgICBpZiAodGhpcy5leHBsaWNpdGx5Q2xlYXJlZCkgcmV0dXJuO1xuICAgIHZhciBjbSA9IHRoaXMuZG9jLmNtLCB3aXRoT3AgPSBjbSAmJiAhY20uY3VyT3A7XG4gICAgaWYgKHdpdGhPcCkgc3RhcnRPcGVyYXRpb24oY20pO1xuICAgIGlmIChoYXNIYW5kbGVyKHRoaXMsIFwiY2xlYXJcIikpIHtcbiAgICAgIHZhciBmb3VuZCA9IHRoaXMuZmluZCgpO1xuICAgICAgaWYgKGZvdW5kKSBzaWduYWxMYXRlcih0aGlzLCBcImNsZWFyXCIsIGZvdW5kLmZyb20sIGZvdW5kLnRvKTtcbiAgICB9XG4gICAgdmFyIG1pbiA9IG51bGwsIG1heCA9IG51bGw7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLmxpbmVzLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YXIgbGluZSA9IHRoaXMubGluZXNbaV07XG4gICAgICB2YXIgc3BhbiA9IGdldE1hcmtlZFNwYW5Gb3IobGluZS5tYXJrZWRTcGFucywgdGhpcyk7XG4gICAgICBpZiAoY20gJiYgIXRoaXMuY29sbGFwc2VkKSByZWdMaW5lQ2hhbmdlKGNtLCBsaW5lTm8obGluZSksIFwidGV4dFwiKTtcbiAgICAgIGVsc2UgaWYgKGNtKSB7XG4gICAgICAgIGlmIChzcGFuLnRvICE9IG51bGwpIG1heCA9IGxpbmVObyhsaW5lKTtcbiAgICAgICAgaWYgKHNwYW4uZnJvbSAhPSBudWxsKSBtaW4gPSBsaW5lTm8obGluZSk7XG4gICAgICB9XG4gICAgICBsaW5lLm1hcmtlZFNwYW5zID0gcmVtb3ZlTWFya2VkU3BhbihsaW5lLm1hcmtlZFNwYW5zLCBzcGFuKTtcbiAgICAgIGlmIChzcGFuLmZyb20gPT0gbnVsbCAmJiB0aGlzLmNvbGxhcHNlZCAmJiAhbGluZUlzSGlkZGVuKHRoaXMuZG9jLCBsaW5lKSAmJiBjbSlcbiAgICAgICAgdXBkYXRlTGluZUhlaWdodChsaW5lLCB0ZXh0SGVpZ2h0KGNtLmRpc3BsYXkpKTtcbiAgICB9XG4gICAgaWYgKGNtICYmIHRoaXMuY29sbGFwc2VkICYmICFjbS5vcHRpb25zLmxpbmVXcmFwcGluZykgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLmxpbmVzLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YXIgdmlzdWFsID0gdmlzdWFsTGluZSh0aGlzLmxpbmVzW2ldKSwgbGVuID0gbGluZUxlbmd0aCh2aXN1YWwpO1xuICAgICAgaWYgKGxlbiA+IGNtLmRpc3BsYXkubWF4TGluZUxlbmd0aCkge1xuICAgICAgICBjbS5kaXNwbGF5Lm1heExpbmUgPSB2aXN1YWw7XG4gICAgICAgIGNtLmRpc3BsYXkubWF4TGluZUxlbmd0aCA9IGxlbjtcbiAgICAgICAgY20uZGlzcGxheS5tYXhMaW5lQ2hhbmdlZCA9IHRydWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKG1pbiAhPSBudWxsICYmIGNtICYmIHRoaXMuY29sbGFwc2VkKSByZWdDaGFuZ2UoY20sIG1pbiwgbWF4ICsgMSk7XG4gICAgdGhpcy5saW5lcy5sZW5ndGggPSAwO1xuICAgIHRoaXMuZXhwbGljaXRseUNsZWFyZWQgPSB0cnVlO1xuICAgIGlmICh0aGlzLmF0b21pYyAmJiB0aGlzLmRvYy5jYW50RWRpdCkge1xuICAgICAgdGhpcy5kb2MuY2FudEVkaXQgPSBmYWxzZTtcbiAgICAgIGlmIChjbSkgcmVDaGVja1NlbGVjdGlvbihjbS5kb2MpO1xuICAgIH1cbiAgICBpZiAoY20pIHNpZ25hbExhdGVyKGNtLCBcIm1hcmtlckNsZWFyZWRcIiwgY20sIHRoaXMpO1xuICAgIGlmICh3aXRoT3ApIGVuZE9wZXJhdGlvbihjbSk7XG4gICAgaWYgKHRoaXMucGFyZW50KSB0aGlzLnBhcmVudC5jbGVhcigpO1xuICB9O1xuXG4gIC8vIEZpbmQgdGhlIHBvc2l0aW9uIG9mIHRoZSBtYXJrZXIgaW4gdGhlIGRvY3VtZW50LiBSZXR1cm5zIGEge2Zyb20sXG4gIC8vIHRvfSBvYmplY3QgYnkgZGVmYXVsdC4gU2lkZSBjYW4gYmUgcGFzc2VkIHRvIGdldCBhIHNwZWNpZmljIHNpZGVcbiAgLy8gLS0gMCAoYm90aCksIC0xIChsZWZ0KSwgb3IgMSAocmlnaHQpLiBXaGVuIGxpbmVPYmogaXMgdHJ1ZSwgdGhlXG4gIC8vIFBvcyBvYmplY3RzIHJldHVybmVkIGNvbnRhaW4gYSBsaW5lIG9iamVjdCwgcmF0aGVyIHRoYW4gYSBsaW5lXG4gIC8vIG51bWJlciAodXNlZCB0byBwcmV2ZW50IGxvb2tpbmcgdXAgdGhlIHNhbWUgbGluZSB0d2ljZSkuXG4gIFRleHRNYXJrZXIucHJvdG90eXBlLmZpbmQgPSBmdW5jdGlvbihzaWRlLCBsaW5lT2JqKSB7XG4gICAgaWYgKHNpZGUgPT0gbnVsbCAmJiB0aGlzLnR5cGUgPT0gXCJib29rbWFya1wiKSBzaWRlID0gMTtcbiAgICB2YXIgZnJvbSwgdG87XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLmxpbmVzLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YXIgbGluZSA9IHRoaXMubGluZXNbaV07XG4gICAgICB2YXIgc3BhbiA9IGdldE1hcmtlZFNwYW5Gb3IobGluZS5tYXJrZWRTcGFucywgdGhpcyk7XG4gICAgICBpZiAoc3Bhbi5mcm9tICE9IG51bGwpIHtcbiAgICAgICAgZnJvbSA9IFBvcyhsaW5lT2JqID8gbGluZSA6IGxpbmVObyhsaW5lKSwgc3Bhbi5mcm9tKTtcbiAgICAgICAgaWYgKHNpZGUgPT0gLTEpIHJldHVybiBmcm9tO1xuICAgICAgfVxuICAgICAgaWYgKHNwYW4udG8gIT0gbnVsbCkge1xuICAgICAgICB0byA9IFBvcyhsaW5lT2JqID8gbGluZSA6IGxpbmVObyhsaW5lKSwgc3Bhbi50byk7XG4gICAgICAgIGlmIChzaWRlID09IDEpIHJldHVybiB0bztcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGZyb20gJiYge2Zyb206IGZyb20sIHRvOiB0b307XG4gIH07XG5cbiAgLy8gU2lnbmFscyB0aGF0IHRoZSBtYXJrZXIncyB3aWRnZXQgY2hhbmdlZCwgYW5kIHN1cnJvdW5kaW5nIGxheW91dFxuICAvLyBzaG91bGQgYmUgcmVjb21wdXRlZC5cbiAgVGV4dE1hcmtlci5wcm90b3R5cGUuY2hhbmdlZCA9IGZ1bmN0aW9uKCkge1xuICAgIHZhciBwb3MgPSB0aGlzLmZpbmQoLTEsIHRydWUpLCB3aWRnZXQgPSB0aGlzLCBjbSA9IHRoaXMuZG9jLmNtO1xuICAgIGlmICghcG9zIHx8ICFjbSkgcmV0dXJuO1xuICAgIHJ1bkluT3AoY20sIGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIGxpbmUgPSBwb3MubGluZSwgbGluZU4gPSBsaW5lTm8ocG9zLmxpbmUpO1xuICAgICAgdmFyIHZpZXcgPSBmaW5kVmlld0ZvckxpbmUoY20sIGxpbmVOKTtcbiAgICAgIGlmICh2aWV3KSB7XG4gICAgICAgIGNsZWFyTGluZU1lYXN1cmVtZW50Q2FjaGVGb3Iodmlldyk7XG4gICAgICAgIGNtLmN1ck9wLnNlbGVjdGlvbkNoYW5nZWQgPSBjbS5jdXJPcC5mb3JjZVVwZGF0ZSA9IHRydWU7XG4gICAgICB9XG4gICAgICBjbS5jdXJPcC51cGRhdGVNYXhMaW5lID0gdHJ1ZTtcbiAgICAgIGlmICghbGluZUlzSGlkZGVuKHdpZGdldC5kb2MsIGxpbmUpICYmIHdpZGdldC5oZWlnaHQgIT0gbnVsbCkge1xuICAgICAgICB2YXIgb2xkSGVpZ2h0ID0gd2lkZ2V0LmhlaWdodDtcbiAgICAgICAgd2lkZ2V0LmhlaWdodCA9IG51bGw7XG4gICAgICAgIHZhciBkSGVpZ2h0ID0gd2lkZ2V0SGVpZ2h0KHdpZGdldCkgLSBvbGRIZWlnaHQ7XG4gICAgICAgIGlmIChkSGVpZ2h0KVxuICAgICAgICAgIHVwZGF0ZUxpbmVIZWlnaHQobGluZSwgbGluZS5oZWlnaHQgKyBkSGVpZ2h0KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfTtcblxuICBUZXh0TWFya2VyLnByb3RvdHlwZS5hdHRhY2hMaW5lID0gZnVuY3Rpb24obGluZSkge1xuICAgIGlmICghdGhpcy5saW5lcy5sZW5ndGggJiYgdGhpcy5kb2MuY20pIHtcbiAgICAgIHZhciBvcCA9IHRoaXMuZG9jLmNtLmN1ck9wO1xuICAgICAgaWYgKCFvcC5tYXliZUhpZGRlbk1hcmtlcnMgfHwgaW5kZXhPZihvcC5tYXliZUhpZGRlbk1hcmtlcnMsIHRoaXMpID09IC0xKVxuICAgICAgICAob3AubWF5YmVVbmhpZGRlbk1hcmtlcnMgfHwgKG9wLm1heWJlVW5oaWRkZW5NYXJrZXJzID0gW10pKS5wdXNoKHRoaXMpO1xuICAgIH1cbiAgICB0aGlzLmxpbmVzLnB1c2gobGluZSk7XG4gIH07XG4gIFRleHRNYXJrZXIucHJvdG90eXBlLmRldGFjaExpbmUgPSBmdW5jdGlvbihsaW5lKSB7XG4gICAgdGhpcy5saW5lcy5zcGxpY2UoaW5kZXhPZih0aGlzLmxpbmVzLCBsaW5lKSwgMSk7XG4gICAgaWYgKCF0aGlzLmxpbmVzLmxlbmd0aCAmJiB0aGlzLmRvYy5jbSkge1xuICAgICAgdmFyIG9wID0gdGhpcy5kb2MuY20uY3VyT3A7XG4gICAgICAob3AubWF5YmVIaWRkZW5NYXJrZXJzIHx8IChvcC5tYXliZUhpZGRlbk1hcmtlcnMgPSBbXSkpLnB1c2godGhpcyk7XG4gICAgfVxuICB9O1xuXG4gIC8vIENvbGxhcHNlZCBtYXJrZXJzIGhhdmUgdW5pcXVlIGlkcywgaW4gb3JkZXIgdG8gYmUgYWJsZSB0byBvcmRlclxuICAvLyB0aGVtLCB3aGljaCBpcyBuZWVkZWQgZm9yIHVuaXF1ZWx5IGRldGVybWluaW5nIGFuIG91dGVyIG1hcmtlclxuICAvLyB3aGVuIHRoZXkgb3ZlcmxhcCAodGhleSBtYXkgbmVzdCwgYnV0IG5vdCBwYXJ0aWFsbHkgb3ZlcmxhcCkuXG4gIHZhciBuZXh0TWFya2VySWQgPSAwO1xuXG4gIC8vIENyZWF0ZSBhIG1hcmtlciwgd2lyZSBpdCB1cCB0byB0aGUgcmlnaHQgbGluZXMsIGFuZFxuICBmdW5jdGlvbiBtYXJrVGV4dChkb2MsIGZyb20sIHRvLCBvcHRpb25zLCB0eXBlKSB7XG4gICAgLy8gU2hhcmVkIG1hcmtlcnMgKGFjcm9zcyBsaW5rZWQgZG9jdW1lbnRzKSBhcmUgaGFuZGxlZCBzZXBhcmF0ZWx5XG4gICAgLy8gKG1hcmtUZXh0U2hhcmVkIHdpbGwgY2FsbCBvdXQgdG8gdGhpcyBhZ2Fpbiwgb25jZSBwZXJcbiAgICAvLyBkb2N1bWVudCkuXG4gICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5zaGFyZWQpIHJldHVybiBtYXJrVGV4dFNoYXJlZChkb2MsIGZyb20sIHRvLCBvcHRpb25zLCB0eXBlKTtcbiAgICAvLyBFbnN1cmUgd2UgYXJlIGluIGFuIG9wZXJhdGlvbi5cbiAgICBpZiAoZG9jLmNtICYmICFkb2MuY20uY3VyT3ApIHJldHVybiBvcGVyYXRpb24oZG9jLmNtLCBtYXJrVGV4dCkoZG9jLCBmcm9tLCB0bywgb3B0aW9ucywgdHlwZSk7XG5cbiAgICB2YXIgbWFya2VyID0gbmV3IFRleHRNYXJrZXIoZG9jLCB0eXBlKSwgZGlmZiA9IGNtcChmcm9tLCB0byk7XG4gICAgaWYgKG9wdGlvbnMpIGNvcHlPYmoob3B0aW9ucywgbWFya2VyLCBmYWxzZSk7XG4gICAgLy8gRG9uJ3QgY29ubmVjdCBlbXB0eSBtYXJrZXJzIHVubGVzcyBjbGVhcldoZW5FbXB0eSBpcyBmYWxzZVxuICAgIGlmIChkaWZmID4gMCB8fCBkaWZmID09IDAgJiYgbWFya2VyLmNsZWFyV2hlbkVtcHR5ICE9PSBmYWxzZSlcbiAgICAgIHJldHVybiBtYXJrZXI7XG4gICAgaWYgKG1hcmtlci5yZXBsYWNlZFdpdGgpIHtcbiAgICAgIC8vIFNob3dpbmcgdXAgYXMgYSB3aWRnZXQgaW1wbGllcyBjb2xsYXBzZWQgKHdpZGdldCByZXBsYWNlcyB0ZXh0KVxuICAgICAgbWFya2VyLmNvbGxhcHNlZCA9IHRydWU7XG4gICAgICBtYXJrZXIud2lkZ2V0Tm9kZSA9IGVsdChcInNwYW5cIiwgW21hcmtlci5yZXBsYWNlZFdpdGhdLCBcIkNvZGVNaXJyb3Itd2lkZ2V0XCIpO1xuICAgICAgaWYgKCFvcHRpb25zLmhhbmRsZU1vdXNlRXZlbnRzKSBtYXJrZXIud2lkZ2V0Tm9kZS5pZ25vcmVFdmVudHMgPSB0cnVlO1xuICAgICAgaWYgKG9wdGlvbnMuaW5zZXJ0TGVmdCkgbWFya2VyLndpZGdldE5vZGUuaW5zZXJ0TGVmdCA9IHRydWU7XG4gICAgfVxuICAgIGlmIChtYXJrZXIuY29sbGFwc2VkKSB7XG4gICAgICBpZiAoY29uZmxpY3RpbmdDb2xsYXBzZWRSYW5nZShkb2MsIGZyb20ubGluZSwgZnJvbSwgdG8sIG1hcmtlcikgfHxcbiAgICAgICAgICBmcm9tLmxpbmUgIT0gdG8ubGluZSAmJiBjb25mbGljdGluZ0NvbGxhcHNlZFJhbmdlKGRvYywgdG8ubGluZSwgZnJvbSwgdG8sIG1hcmtlcikpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkluc2VydGluZyBjb2xsYXBzZWQgbWFya2VyIHBhcnRpYWxseSBvdmVybGFwcGluZyBhbiBleGlzdGluZyBvbmVcIik7XG4gICAgICBzYXdDb2xsYXBzZWRTcGFucyA9IHRydWU7XG4gICAgfVxuXG4gICAgaWYgKG1hcmtlci5hZGRUb0hpc3RvcnkpXG4gICAgICBhZGRDaGFuZ2VUb0hpc3RvcnkoZG9jLCB7ZnJvbTogZnJvbSwgdG86IHRvLCBvcmlnaW46IFwibWFya1RleHRcIn0sIGRvYy5zZWwsIE5hTik7XG5cbiAgICB2YXIgY3VyTGluZSA9IGZyb20ubGluZSwgY20gPSBkb2MuY20sIHVwZGF0ZU1heExpbmU7XG4gICAgZG9jLml0ZXIoY3VyTGluZSwgdG8ubGluZSArIDEsIGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgIGlmIChjbSAmJiBtYXJrZXIuY29sbGFwc2VkICYmICFjbS5vcHRpb25zLmxpbmVXcmFwcGluZyAmJiB2aXN1YWxMaW5lKGxpbmUpID09IGNtLmRpc3BsYXkubWF4TGluZSlcbiAgICAgICAgdXBkYXRlTWF4TGluZSA9IHRydWU7XG4gICAgICBpZiAobWFya2VyLmNvbGxhcHNlZCAmJiBjdXJMaW5lICE9IGZyb20ubGluZSkgdXBkYXRlTGluZUhlaWdodChsaW5lLCAwKTtcbiAgICAgIGFkZE1hcmtlZFNwYW4obGluZSwgbmV3IE1hcmtlZFNwYW4obWFya2VyLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjdXJMaW5lID09IGZyb20ubGluZSA/IGZyb20uY2ggOiBudWxsLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjdXJMaW5lID09IHRvLmxpbmUgPyB0by5jaCA6IG51bGwpKTtcbiAgICAgICsrY3VyTGluZTtcbiAgICB9KTtcbiAgICAvLyBsaW5lSXNIaWRkZW4gZGVwZW5kcyBvbiB0aGUgcHJlc2VuY2Ugb2YgdGhlIHNwYW5zLCBzbyBuZWVkcyBhIHNlY29uZCBwYXNzXG4gICAgaWYgKG1hcmtlci5jb2xsYXBzZWQpIGRvYy5pdGVyKGZyb20ubGluZSwgdG8ubGluZSArIDEsIGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgIGlmIChsaW5lSXNIaWRkZW4oZG9jLCBsaW5lKSkgdXBkYXRlTGluZUhlaWdodChsaW5lLCAwKTtcbiAgICB9KTtcblxuICAgIGlmIChtYXJrZXIuY2xlYXJPbkVudGVyKSBvbihtYXJrZXIsIFwiYmVmb3JlQ3Vyc29yRW50ZXJcIiwgZnVuY3Rpb24oKSB7IG1hcmtlci5jbGVhcigpOyB9KTtcblxuICAgIGlmIChtYXJrZXIucmVhZE9ubHkpIHtcbiAgICAgIHNhd1JlYWRPbmx5U3BhbnMgPSB0cnVlO1xuICAgICAgaWYgKGRvYy5oaXN0b3J5LmRvbmUubGVuZ3RoIHx8IGRvYy5oaXN0b3J5LnVuZG9uZS5sZW5ndGgpXG4gICAgICAgIGRvYy5jbGVhckhpc3RvcnkoKTtcbiAgICB9XG4gICAgaWYgKG1hcmtlci5jb2xsYXBzZWQpIHtcbiAgICAgIG1hcmtlci5pZCA9ICsrbmV4dE1hcmtlcklkO1xuICAgICAgbWFya2VyLmF0b21pYyA9IHRydWU7XG4gICAgfVxuICAgIGlmIChjbSkge1xuICAgICAgLy8gU3luYyBlZGl0b3Igc3RhdGVcbiAgICAgIGlmICh1cGRhdGVNYXhMaW5lKSBjbS5jdXJPcC51cGRhdGVNYXhMaW5lID0gdHJ1ZTtcbiAgICAgIGlmIChtYXJrZXIuY29sbGFwc2VkKVxuICAgICAgICByZWdDaGFuZ2UoY20sIGZyb20ubGluZSwgdG8ubGluZSArIDEpO1xuICAgICAgZWxzZSBpZiAobWFya2VyLmNsYXNzTmFtZSB8fCBtYXJrZXIudGl0bGUgfHwgbWFya2VyLnN0YXJ0U3R5bGUgfHwgbWFya2VyLmVuZFN0eWxlKVxuICAgICAgICBmb3IgKHZhciBpID0gZnJvbS5saW5lOyBpIDw9IHRvLmxpbmU7IGkrKykgcmVnTGluZUNoYW5nZShjbSwgaSwgXCJ0ZXh0XCIpO1xuICAgICAgaWYgKG1hcmtlci5hdG9taWMpIHJlQ2hlY2tTZWxlY3Rpb24oY20uZG9jKTtcbiAgICAgIHNpZ25hbExhdGVyKGNtLCBcIm1hcmtlckFkZGVkXCIsIGNtLCBtYXJrZXIpO1xuICAgIH1cbiAgICByZXR1cm4gbWFya2VyO1xuICB9XG5cbiAgLy8gU0hBUkVEIFRFWFRNQVJLRVJTXG5cbiAgLy8gQSBzaGFyZWQgbWFya2VyIHNwYW5zIG11bHRpcGxlIGxpbmtlZCBkb2N1bWVudHMuIEl0IGlzXG4gIC8vIGltcGxlbWVudGVkIGFzIGEgbWV0YS1tYXJrZXItb2JqZWN0IGNvbnRyb2xsaW5nIG11bHRpcGxlIG5vcm1hbFxuICAvLyBtYXJrZXJzLlxuICB2YXIgU2hhcmVkVGV4dE1hcmtlciA9IENvZGVNaXJyb3IuU2hhcmVkVGV4dE1hcmtlciA9IGZ1bmN0aW9uKG1hcmtlcnMsIHByaW1hcnkpIHtcbiAgICB0aGlzLm1hcmtlcnMgPSBtYXJrZXJzO1xuICAgIHRoaXMucHJpbWFyeSA9IHByaW1hcnk7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBtYXJrZXJzLmxlbmd0aDsgKytpKVxuICAgICAgbWFya2Vyc1tpXS5wYXJlbnQgPSB0aGlzO1xuICB9O1xuICBldmVudE1peGluKFNoYXJlZFRleHRNYXJrZXIpO1xuXG4gIFNoYXJlZFRleHRNYXJrZXIucHJvdG90eXBlLmNsZWFyID0gZnVuY3Rpb24oKSB7XG4gICAgaWYgKHRoaXMuZXhwbGljaXRseUNsZWFyZWQpIHJldHVybjtcbiAgICB0aGlzLmV4cGxpY2l0bHlDbGVhcmVkID0gdHJ1ZTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHRoaXMubWFya2Vycy5sZW5ndGg7ICsraSlcbiAgICAgIHRoaXMubWFya2Vyc1tpXS5jbGVhcigpO1xuICAgIHNpZ25hbExhdGVyKHRoaXMsIFwiY2xlYXJcIik7XG4gIH07XG4gIFNoYXJlZFRleHRNYXJrZXIucHJvdG90eXBlLmZpbmQgPSBmdW5jdGlvbihzaWRlLCBsaW5lT2JqKSB7XG4gICAgcmV0dXJuIHRoaXMucHJpbWFyeS5maW5kKHNpZGUsIGxpbmVPYmopO1xuICB9O1xuXG4gIGZ1bmN0aW9uIG1hcmtUZXh0U2hhcmVkKGRvYywgZnJvbSwgdG8sIG9wdGlvbnMsIHR5cGUpIHtcbiAgICBvcHRpb25zID0gY29weU9iaihvcHRpb25zKTtcbiAgICBvcHRpb25zLnNoYXJlZCA9IGZhbHNlO1xuICAgIHZhciBtYXJrZXJzID0gW21hcmtUZXh0KGRvYywgZnJvbSwgdG8sIG9wdGlvbnMsIHR5cGUpXSwgcHJpbWFyeSA9IG1hcmtlcnNbMF07XG4gICAgdmFyIHdpZGdldCA9IG9wdGlvbnMud2lkZ2V0Tm9kZTtcbiAgICBsaW5rZWREb2NzKGRvYywgZnVuY3Rpb24oZG9jKSB7XG4gICAgICBpZiAod2lkZ2V0KSBvcHRpb25zLndpZGdldE5vZGUgPSB3aWRnZXQuY2xvbmVOb2RlKHRydWUpO1xuICAgICAgbWFya2Vycy5wdXNoKG1hcmtUZXh0KGRvYywgY2xpcFBvcyhkb2MsIGZyb20pLCBjbGlwUG9zKGRvYywgdG8pLCBvcHRpb25zLCB0eXBlKSk7XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGRvYy5saW5rZWQubGVuZ3RoOyArK2kpXG4gICAgICAgIGlmIChkb2MubGlua2VkW2ldLmlzUGFyZW50KSByZXR1cm47XG4gICAgICBwcmltYXJ5ID0gbHN0KG1hcmtlcnMpO1xuICAgIH0pO1xuICAgIHJldHVybiBuZXcgU2hhcmVkVGV4dE1hcmtlcihtYXJrZXJzLCBwcmltYXJ5KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGZpbmRTaGFyZWRNYXJrZXJzKGRvYykge1xuICAgIHJldHVybiBkb2MuZmluZE1hcmtzKFBvcyhkb2MuZmlyc3QsIDApLCBkb2MuY2xpcFBvcyhQb3MoZG9jLmxhc3RMaW5lKCkpKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICBmdW5jdGlvbihtKSB7IHJldHVybiBtLnBhcmVudDsgfSk7XG4gIH1cblxuICBmdW5jdGlvbiBjb3B5U2hhcmVkTWFya2Vycyhkb2MsIG1hcmtlcnMpIHtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IG1hcmtlcnMubGVuZ3RoOyBpKyspIHtcbiAgICAgIHZhciBtYXJrZXIgPSBtYXJrZXJzW2ldLCBwb3MgPSBtYXJrZXIuZmluZCgpO1xuICAgICAgdmFyIG1Gcm9tID0gZG9jLmNsaXBQb3MocG9zLmZyb20pLCBtVG8gPSBkb2MuY2xpcFBvcyhwb3MudG8pO1xuICAgICAgaWYgKGNtcChtRnJvbSwgbVRvKSkge1xuICAgICAgICB2YXIgc3ViTWFyayA9IG1hcmtUZXh0KGRvYywgbUZyb20sIG1UbywgbWFya2VyLnByaW1hcnksIG1hcmtlci5wcmltYXJ5LnR5cGUpO1xuICAgICAgICBtYXJrZXIubWFya2Vycy5wdXNoKHN1Yk1hcmspO1xuICAgICAgICBzdWJNYXJrLnBhcmVudCA9IG1hcmtlcjtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBkZXRhY2hTaGFyZWRNYXJrZXJzKG1hcmtlcnMpIHtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IG1hcmtlcnMubGVuZ3RoOyBpKyspIHtcbiAgICAgIHZhciBtYXJrZXIgPSBtYXJrZXJzW2ldLCBsaW5rZWQgPSBbbWFya2VyLnByaW1hcnkuZG9jXTs7XG4gICAgICBsaW5rZWREb2NzKG1hcmtlci5wcmltYXJ5LmRvYywgZnVuY3Rpb24oZCkgeyBsaW5rZWQucHVzaChkKTsgfSk7XG4gICAgICBmb3IgKHZhciBqID0gMDsgaiA8IG1hcmtlci5tYXJrZXJzLmxlbmd0aDsgaisrKSB7XG4gICAgICAgIHZhciBzdWJNYXJrZXIgPSBtYXJrZXIubWFya2Vyc1tqXTtcbiAgICAgICAgaWYgKGluZGV4T2YobGlua2VkLCBzdWJNYXJrZXIuZG9jKSA9PSAtMSkge1xuICAgICAgICAgIHN1Yk1hcmtlci5wYXJlbnQgPSBudWxsO1xuICAgICAgICAgIG1hcmtlci5tYXJrZXJzLnNwbGljZShqLS0sIDEpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gVEVYVE1BUktFUiBTUEFOU1xuXG4gIGZ1bmN0aW9uIE1hcmtlZFNwYW4obWFya2VyLCBmcm9tLCB0bykge1xuICAgIHRoaXMubWFya2VyID0gbWFya2VyO1xuICAgIHRoaXMuZnJvbSA9IGZyb207IHRoaXMudG8gPSB0bztcbiAgfVxuXG4gIC8vIFNlYXJjaCBhbiBhcnJheSBvZiBzcGFucyBmb3IgYSBzcGFuIG1hdGNoaW5nIHRoZSBnaXZlbiBtYXJrZXIuXG4gIGZ1bmN0aW9uIGdldE1hcmtlZFNwYW5Gb3Ioc3BhbnMsIG1hcmtlcikge1xuICAgIGlmIChzcGFucykgZm9yICh2YXIgaSA9IDA7IGkgPCBzcGFucy5sZW5ndGg7ICsraSkge1xuICAgICAgdmFyIHNwYW4gPSBzcGFuc1tpXTtcbiAgICAgIGlmIChzcGFuLm1hcmtlciA9PSBtYXJrZXIpIHJldHVybiBzcGFuO1xuICAgIH1cbiAgfVxuICAvLyBSZW1vdmUgYSBzcGFuIGZyb20gYW4gYXJyYXksIHJldHVybmluZyB1bmRlZmluZWQgaWYgbm8gc3BhbnMgYXJlXG4gIC8vIGxlZnQgKHdlIGRvbid0IHN0b3JlIGFycmF5cyBmb3IgbGluZXMgd2l0aG91dCBzcGFucykuXG4gIGZ1bmN0aW9uIHJlbW92ZU1hcmtlZFNwYW4oc3BhbnMsIHNwYW4pIHtcbiAgICBmb3IgKHZhciByLCBpID0gMDsgaSA8IHNwYW5zLmxlbmd0aDsgKytpKVxuICAgICAgaWYgKHNwYW5zW2ldICE9IHNwYW4pIChyIHx8IChyID0gW10pKS5wdXNoKHNwYW5zW2ldKTtcbiAgICByZXR1cm4gcjtcbiAgfVxuICAvLyBBZGQgYSBzcGFuIHRvIGEgbGluZS5cbiAgZnVuY3Rpb24gYWRkTWFya2VkU3BhbihsaW5lLCBzcGFuKSB7XG4gICAgbGluZS5tYXJrZWRTcGFucyA9IGxpbmUubWFya2VkU3BhbnMgPyBsaW5lLm1hcmtlZFNwYW5zLmNvbmNhdChbc3Bhbl0pIDogW3NwYW5dO1xuICAgIHNwYW4ubWFya2VyLmF0dGFjaExpbmUobGluZSk7XG4gIH1cblxuICAvLyBVc2VkIGZvciB0aGUgYWxnb3JpdGhtIHRoYXQgYWRqdXN0cyBtYXJrZXJzIGZvciBhIGNoYW5nZSBpbiB0aGVcbiAgLy8gZG9jdW1lbnQuIFRoZXNlIGZ1bmN0aW9ucyBjdXQgYW4gYXJyYXkgb2Ygc3BhbnMgYXQgYSBnaXZlblxuICAvLyBjaGFyYWN0ZXIgcG9zaXRpb24sIHJldHVybmluZyBhbiBhcnJheSBvZiByZW1haW5pbmcgY2h1bmtzIChvclxuICAvLyB1bmRlZmluZWQgaWYgbm90aGluZyByZW1haW5zKS5cbiAgZnVuY3Rpb24gbWFya2VkU3BhbnNCZWZvcmUob2xkLCBzdGFydENoLCBpc0luc2VydCkge1xuICAgIGlmIChvbGQpIGZvciAodmFyIGkgPSAwLCBudzsgaSA8IG9sZC5sZW5ndGg7ICsraSkge1xuICAgICAgdmFyIHNwYW4gPSBvbGRbaV0sIG1hcmtlciA9IHNwYW4ubWFya2VyO1xuICAgICAgdmFyIHN0YXJ0c0JlZm9yZSA9IHNwYW4uZnJvbSA9PSBudWxsIHx8IChtYXJrZXIuaW5jbHVzaXZlTGVmdCA/IHNwYW4uZnJvbSA8PSBzdGFydENoIDogc3Bhbi5mcm9tIDwgc3RhcnRDaCk7XG4gICAgICBpZiAoc3RhcnRzQmVmb3JlIHx8IHNwYW4uZnJvbSA9PSBzdGFydENoICYmIG1hcmtlci50eXBlID09IFwiYm9va21hcmtcIiAmJiAoIWlzSW5zZXJ0IHx8ICFzcGFuLm1hcmtlci5pbnNlcnRMZWZ0KSkge1xuICAgICAgICB2YXIgZW5kc0FmdGVyID0gc3Bhbi50byA9PSBudWxsIHx8IChtYXJrZXIuaW5jbHVzaXZlUmlnaHQgPyBzcGFuLnRvID49IHN0YXJ0Q2ggOiBzcGFuLnRvID4gc3RhcnRDaCk7XG4gICAgICAgIChudyB8fCAobncgPSBbXSkpLnB1c2gobmV3IE1hcmtlZFNwYW4obWFya2VyLCBzcGFuLmZyb20sIGVuZHNBZnRlciA/IG51bGwgOiBzcGFuLnRvKSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBudztcbiAgfVxuICBmdW5jdGlvbiBtYXJrZWRTcGFuc0FmdGVyKG9sZCwgZW5kQ2gsIGlzSW5zZXJ0KSB7XG4gICAgaWYgKG9sZCkgZm9yICh2YXIgaSA9IDAsIG53OyBpIDwgb2xkLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YXIgc3BhbiA9IG9sZFtpXSwgbWFya2VyID0gc3Bhbi5tYXJrZXI7XG4gICAgICB2YXIgZW5kc0FmdGVyID0gc3Bhbi50byA9PSBudWxsIHx8IChtYXJrZXIuaW5jbHVzaXZlUmlnaHQgPyBzcGFuLnRvID49IGVuZENoIDogc3Bhbi50byA+IGVuZENoKTtcbiAgICAgIGlmIChlbmRzQWZ0ZXIgfHwgc3Bhbi5mcm9tID09IGVuZENoICYmIG1hcmtlci50eXBlID09IFwiYm9va21hcmtcIiAmJiAoIWlzSW5zZXJ0IHx8IHNwYW4ubWFya2VyLmluc2VydExlZnQpKSB7XG4gICAgICAgIHZhciBzdGFydHNCZWZvcmUgPSBzcGFuLmZyb20gPT0gbnVsbCB8fCAobWFya2VyLmluY2x1c2l2ZUxlZnQgPyBzcGFuLmZyb20gPD0gZW5kQ2ggOiBzcGFuLmZyb20gPCBlbmRDaCk7XG4gICAgICAgIChudyB8fCAobncgPSBbXSkpLnB1c2gobmV3IE1hcmtlZFNwYW4obWFya2VyLCBzdGFydHNCZWZvcmUgPyBudWxsIDogc3Bhbi5mcm9tIC0gZW5kQ2gsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3Bhbi50byA9PSBudWxsID8gbnVsbCA6IHNwYW4udG8gLSBlbmRDaCkpO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gbnc7XG4gIH1cblxuICAvLyBHaXZlbiBhIGNoYW5nZSBvYmplY3QsIGNvbXB1dGUgdGhlIG5ldyBzZXQgb2YgbWFya2VyIHNwYW5zIHRoYXRcbiAgLy8gY292ZXIgdGhlIGxpbmUgaW4gd2hpY2ggdGhlIGNoYW5nZSB0b29rIHBsYWNlLiBSZW1vdmVzIHNwYW5zXG4gIC8vIGVudGlyZWx5IHdpdGhpbiB0aGUgY2hhbmdlLCByZWNvbm5lY3RzIHNwYW5zIGJlbG9uZ2luZyB0byB0aGVcbiAgLy8gc2FtZSBtYXJrZXIgdGhhdCBhcHBlYXIgb24gYm90aCBzaWRlcyBvZiB0aGUgY2hhbmdlLCBhbmQgY3V0cyBvZmZcbiAgLy8gc3BhbnMgcGFydGlhbGx5IHdpdGhpbiB0aGUgY2hhbmdlLiBSZXR1cm5zIGFuIGFycmF5IG9mIHNwYW5cbiAgLy8gYXJyYXlzIHdpdGggb25lIGVsZW1lbnQgZm9yIGVhY2ggbGluZSBpbiAoYWZ0ZXIpIHRoZSBjaGFuZ2UuXG4gIGZ1bmN0aW9uIHN0cmV0Y2hTcGFuc092ZXJDaGFuZ2UoZG9jLCBjaGFuZ2UpIHtcbiAgICB2YXIgb2xkRmlyc3QgPSBpc0xpbmUoZG9jLCBjaGFuZ2UuZnJvbS5saW5lKSAmJiBnZXRMaW5lKGRvYywgY2hhbmdlLmZyb20ubGluZSkubWFya2VkU3BhbnM7XG4gICAgdmFyIG9sZExhc3QgPSBpc0xpbmUoZG9jLCBjaGFuZ2UudG8ubGluZSkgJiYgZ2V0TGluZShkb2MsIGNoYW5nZS50by5saW5lKS5tYXJrZWRTcGFucztcbiAgICBpZiAoIW9sZEZpcnN0ICYmICFvbGRMYXN0KSByZXR1cm4gbnVsbDtcblxuICAgIHZhciBzdGFydENoID0gY2hhbmdlLmZyb20uY2gsIGVuZENoID0gY2hhbmdlLnRvLmNoLCBpc0luc2VydCA9IGNtcChjaGFuZ2UuZnJvbSwgY2hhbmdlLnRvKSA9PSAwO1xuICAgIC8vIEdldCB0aGUgc3BhbnMgdGhhdCAnc3RpY2sgb3V0JyBvbiBib3RoIHNpZGVzXG4gICAgdmFyIGZpcnN0ID0gbWFya2VkU3BhbnNCZWZvcmUob2xkRmlyc3QsIHN0YXJ0Q2gsIGlzSW5zZXJ0KTtcbiAgICB2YXIgbGFzdCA9IG1hcmtlZFNwYW5zQWZ0ZXIob2xkTGFzdCwgZW5kQ2gsIGlzSW5zZXJ0KTtcblxuICAgIC8vIE5leHQsIG1lcmdlIHRob3NlIHR3byBlbmRzXG4gICAgdmFyIHNhbWVMaW5lID0gY2hhbmdlLnRleHQubGVuZ3RoID09IDEsIG9mZnNldCA9IGxzdChjaGFuZ2UudGV4dCkubGVuZ3RoICsgKHNhbWVMaW5lID8gc3RhcnRDaCA6IDApO1xuICAgIGlmIChmaXJzdCkge1xuICAgICAgLy8gRml4IHVwIC50byBwcm9wZXJ0aWVzIG9mIGZpcnN0XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZpcnN0Lmxlbmd0aDsgKytpKSB7XG4gICAgICAgIHZhciBzcGFuID0gZmlyc3RbaV07XG4gICAgICAgIGlmIChzcGFuLnRvID09IG51bGwpIHtcbiAgICAgICAgICB2YXIgZm91bmQgPSBnZXRNYXJrZWRTcGFuRm9yKGxhc3QsIHNwYW4ubWFya2VyKTtcbiAgICAgICAgICBpZiAoIWZvdW5kKSBzcGFuLnRvID0gc3RhcnRDaDtcbiAgICAgICAgICBlbHNlIGlmIChzYW1lTGluZSkgc3Bhbi50byA9IGZvdW5kLnRvID09IG51bGwgPyBudWxsIDogZm91bmQudG8gKyBvZmZzZXQ7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKGxhc3QpIHtcbiAgICAgIC8vIEZpeCB1cCAuZnJvbSBpbiBsYXN0IChvciBtb3ZlIHRoZW0gaW50byBmaXJzdCBpbiBjYXNlIG9mIHNhbWVMaW5lKVxuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsYXN0Lmxlbmd0aDsgKytpKSB7XG4gICAgICAgIHZhciBzcGFuID0gbGFzdFtpXTtcbiAgICAgICAgaWYgKHNwYW4udG8gIT0gbnVsbCkgc3Bhbi50byArPSBvZmZzZXQ7XG4gICAgICAgIGlmIChzcGFuLmZyb20gPT0gbnVsbCkge1xuICAgICAgICAgIHZhciBmb3VuZCA9IGdldE1hcmtlZFNwYW5Gb3IoZmlyc3QsIHNwYW4ubWFya2VyKTtcbiAgICAgICAgICBpZiAoIWZvdW5kKSB7XG4gICAgICAgICAgICBzcGFuLmZyb20gPSBvZmZzZXQ7XG4gICAgICAgICAgICBpZiAoc2FtZUxpbmUpIChmaXJzdCB8fCAoZmlyc3QgPSBbXSkpLnB1c2goc3Bhbik7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHNwYW4uZnJvbSArPSBvZmZzZXQ7XG4gICAgICAgICAgaWYgKHNhbWVMaW5lKSAoZmlyc3QgfHwgKGZpcnN0ID0gW10pKS5wdXNoKHNwYW4pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIC8vIE1ha2Ugc3VyZSB3ZSBkaWRuJ3QgY3JlYXRlIGFueSB6ZXJvLWxlbmd0aCBzcGFuc1xuICAgIGlmIChmaXJzdCkgZmlyc3QgPSBjbGVhckVtcHR5U3BhbnMoZmlyc3QpO1xuICAgIGlmIChsYXN0ICYmIGxhc3QgIT0gZmlyc3QpIGxhc3QgPSBjbGVhckVtcHR5U3BhbnMobGFzdCk7XG5cbiAgICB2YXIgbmV3TWFya2VycyA9IFtmaXJzdF07XG4gICAgaWYgKCFzYW1lTGluZSkge1xuICAgICAgLy8gRmlsbCBnYXAgd2l0aCB3aG9sZS1saW5lLXNwYW5zXG4gICAgICB2YXIgZ2FwID0gY2hhbmdlLnRleHQubGVuZ3RoIC0gMiwgZ2FwTWFya2VycztcbiAgICAgIGlmIChnYXAgPiAwICYmIGZpcnN0KVxuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZpcnN0Lmxlbmd0aDsgKytpKVxuICAgICAgICAgIGlmIChmaXJzdFtpXS50byA9PSBudWxsKVxuICAgICAgICAgICAgKGdhcE1hcmtlcnMgfHwgKGdhcE1hcmtlcnMgPSBbXSkpLnB1c2gobmV3IE1hcmtlZFNwYW4oZmlyc3RbaV0ubWFya2VyLCBudWxsLCBudWxsKSk7XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGdhcDsgKytpKVxuICAgICAgICBuZXdNYXJrZXJzLnB1c2goZ2FwTWFya2Vycyk7XG4gICAgICBuZXdNYXJrZXJzLnB1c2gobGFzdCk7XG4gICAgfVxuICAgIHJldHVybiBuZXdNYXJrZXJzO1xuICB9XG5cbiAgLy8gUmVtb3ZlIHNwYW5zIHRoYXQgYXJlIGVtcHR5IGFuZCBkb24ndCBoYXZlIGEgY2xlYXJXaGVuRW1wdHlcbiAgLy8gb3B0aW9uIG9mIGZhbHNlLlxuICBmdW5jdGlvbiBjbGVhckVtcHR5U3BhbnMoc3BhbnMpIHtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHNwYW5zLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YXIgc3BhbiA9IHNwYW5zW2ldO1xuICAgICAgaWYgKHNwYW4uZnJvbSAhPSBudWxsICYmIHNwYW4uZnJvbSA9PSBzcGFuLnRvICYmIHNwYW4ubWFya2VyLmNsZWFyV2hlbkVtcHR5ICE9PSBmYWxzZSlcbiAgICAgICAgc3BhbnMuc3BsaWNlKGktLSwgMSk7XG4gICAgfVxuICAgIGlmICghc3BhbnMubGVuZ3RoKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4gc3BhbnM7XG4gIH1cblxuICAvLyBVc2VkIGZvciB1bi9yZS1kb2luZyBjaGFuZ2VzIGZyb20gdGhlIGhpc3RvcnkuIENvbWJpbmVzIHRoZVxuICAvLyByZXN1bHQgb2YgY29tcHV0aW5nIHRoZSBleGlzdGluZyBzcGFucyB3aXRoIHRoZSBzZXQgb2Ygc3BhbnMgdGhhdFxuICAvLyBleGlzdGVkIGluIHRoZSBoaXN0b3J5IChzbyB0aGF0IGRlbGV0aW5nIGFyb3VuZCBhIHNwYW4gYW5kIHRoZW5cbiAgLy8gdW5kb2luZyBicmluZ3MgYmFjayB0aGUgc3BhbikuXG4gIGZ1bmN0aW9uIG1lcmdlT2xkU3BhbnMoZG9jLCBjaGFuZ2UpIHtcbiAgICB2YXIgb2xkID0gZ2V0T2xkU3BhbnMoZG9jLCBjaGFuZ2UpO1xuICAgIHZhciBzdHJldGNoZWQgPSBzdHJldGNoU3BhbnNPdmVyQ2hhbmdlKGRvYywgY2hhbmdlKTtcbiAgICBpZiAoIW9sZCkgcmV0dXJuIHN0cmV0Y2hlZDtcbiAgICBpZiAoIXN0cmV0Y2hlZCkgcmV0dXJuIG9sZDtcblxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgb2xkLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YXIgb2xkQ3VyID0gb2xkW2ldLCBzdHJldGNoQ3VyID0gc3RyZXRjaGVkW2ldO1xuICAgICAgaWYgKG9sZEN1ciAmJiBzdHJldGNoQ3VyKSB7XG4gICAgICAgIHNwYW5zOiBmb3IgKHZhciBqID0gMDsgaiA8IHN0cmV0Y2hDdXIubGVuZ3RoOyArK2opIHtcbiAgICAgICAgICB2YXIgc3BhbiA9IHN0cmV0Y2hDdXJbal07XG4gICAgICAgICAgZm9yICh2YXIgayA9IDA7IGsgPCBvbGRDdXIubGVuZ3RoOyArK2spXG4gICAgICAgICAgICBpZiAob2xkQ3VyW2tdLm1hcmtlciA9PSBzcGFuLm1hcmtlcikgY29udGludWUgc3BhbnM7XG4gICAgICAgICAgb2xkQ3VyLnB1c2goc3Bhbik7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoc3RyZXRjaEN1cikge1xuICAgICAgICBvbGRbaV0gPSBzdHJldGNoQ3VyO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gb2xkO1xuICB9XG5cbiAgLy8gVXNlZCB0byAnY2xpcCcgb3V0IHJlYWRPbmx5IHJhbmdlcyB3aGVuIG1ha2luZyBhIGNoYW5nZS5cbiAgZnVuY3Rpb24gcmVtb3ZlUmVhZE9ubHlSYW5nZXMoZG9jLCBmcm9tLCB0bykge1xuICAgIHZhciBtYXJrZXJzID0gbnVsbDtcbiAgICBkb2MuaXRlcihmcm9tLmxpbmUsIHRvLmxpbmUgKyAxLCBmdW5jdGlvbihsaW5lKSB7XG4gICAgICBpZiAobGluZS5tYXJrZWRTcGFucykgZm9yICh2YXIgaSA9IDA7IGkgPCBsaW5lLm1hcmtlZFNwYW5zLmxlbmd0aDsgKytpKSB7XG4gICAgICAgIHZhciBtYXJrID0gbGluZS5tYXJrZWRTcGFuc1tpXS5tYXJrZXI7XG4gICAgICAgIGlmIChtYXJrLnJlYWRPbmx5ICYmICghbWFya2VycyB8fCBpbmRleE9mKG1hcmtlcnMsIG1hcmspID09IC0xKSlcbiAgICAgICAgICAobWFya2VycyB8fCAobWFya2VycyA9IFtdKSkucHVzaChtYXJrKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBpZiAoIW1hcmtlcnMpIHJldHVybiBudWxsO1xuICAgIHZhciBwYXJ0cyA9IFt7ZnJvbTogZnJvbSwgdG86IHRvfV07XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBtYXJrZXJzLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YXIgbWsgPSBtYXJrZXJzW2ldLCBtID0gbWsuZmluZCgwKTtcbiAgICAgIGZvciAodmFyIGogPSAwOyBqIDwgcGFydHMubGVuZ3RoOyArK2opIHtcbiAgICAgICAgdmFyIHAgPSBwYXJ0c1tqXTtcbiAgICAgICAgaWYgKGNtcChwLnRvLCBtLmZyb20pIDwgMCB8fCBjbXAocC5mcm9tLCBtLnRvKSA+IDApIGNvbnRpbnVlO1xuICAgICAgICB2YXIgbmV3UGFydHMgPSBbaiwgMV0sIGRmcm9tID0gY21wKHAuZnJvbSwgbS5mcm9tKSwgZHRvID0gY21wKHAudG8sIG0udG8pO1xuICAgICAgICBpZiAoZGZyb20gPCAwIHx8ICFtay5pbmNsdXNpdmVMZWZ0ICYmICFkZnJvbSlcbiAgICAgICAgICBuZXdQYXJ0cy5wdXNoKHtmcm9tOiBwLmZyb20sIHRvOiBtLmZyb219KTtcbiAgICAgICAgaWYgKGR0byA+IDAgfHwgIW1rLmluY2x1c2l2ZVJpZ2h0ICYmICFkdG8pXG4gICAgICAgICAgbmV3UGFydHMucHVzaCh7ZnJvbTogbS50bywgdG86IHAudG99KTtcbiAgICAgICAgcGFydHMuc3BsaWNlLmFwcGx5KHBhcnRzLCBuZXdQYXJ0cyk7XG4gICAgICAgIGogKz0gbmV3UGFydHMubGVuZ3RoIC0gMTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHBhcnRzO1xuICB9XG5cbiAgLy8gQ29ubmVjdCBvciBkaXNjb25uZWN0IHNwYW5zIGZyb20gYSBsaW5lLlxuICBmdW5jdGlvbiBkZXRhY2hNYXJrZWRTcGFucyhsaW5lKSB7XG4gICAgdmFyIHNwYW5zID0gbGluZS5tYXJrZWRTcGFucztcbiAgICBpZiAoIXNwYW5zKSByZXR1cm47XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBzcGFucy5sZW5ndGg7ICsraSlcbiAgICAgIHNwYW5zW2ldLm1hcmtlci5kZXRhY2hMaW5lKGxpbmUpO1xuICAgIGxpbmUubWFya2VkU3BhbnMgPSBudWxsO1xuICB9XG4gIGZ1bmN0aW9uIGF0dGFjaE1hcmtlZFNwYW5zKGxpbmUsIHNwYW5zKSB7XG4gICAgaWYgKCFzcGFucykgcmV0dXJuO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgc3BhbnMubGVuZ3RoOyArK2kpXG4gICAgICBzcGFuc1tpXS5tYXJrZXIuYXR0YWNoTGluZShsaW5lKTtcbiAgICBsaW5lLm1hcmtlZFNwYW5zID0gc3BhbnM7XG4gIH1cblxuICAvLyBIZWxwZXJzIHVzZWQgd2hlbiBjb21wdXRpbmcgd2hpY2ggb3ZlcmxhcHBpbmcgY29sbGFwc2VkIHNwYW5cbiAgLy8gY291bnRzIGFzIHRoZSBsYXJnZXIgb25lLlxuICBmdW5jdGlvbiBleHRyYUxlZnQobWFya2VyKSB7IHJldHVybiBtYXJrZXIuaW5jbHVzaXZlTGVmdCA/IC0xIDogMDsgfVxuICBmdW5jdGlvbiBleHRyYVJpZ2h0KG1hcmtlcikgeyByZXR1cm4gbWFya2VyLmluY2x1c2l2ZVJpZ2h0ID8gMSA6IDA7IH1cblxuICAvLyBSZXR1cm5zIGEgbnVtYmVyIGluZGljYXRpbmcgd2hpY2ggb2YgdHdvIG92ZXJsYXBwaW5nIGNvbGxhcHNlZFxuICAvLyBzcGFucyBpcyBsYXJnZXIgKGFuZCB0aHVzIGluY2x1ZGVzIHRoZSBvdGhlcikuIEZhbGxzIGJhY2sgdG9cbiAgLy8gY29tcGFyaW5nIGlkcyB3aGVuIHRoZSBzcGFucyBjb3ZlciBleGFjdGx5IHRoZSBzYW1lIHJhbmdlLlxuICBmdW5jdGlvbiBjb21wYXJlQ29sbGFwc2VkTWFya2VycyhhLCBiKSB7XG4gICAgdmFyIGxlbkRpZmYgPSBhLmxpbmVzLmxlbmd0aCAtIGIubGluZXMubGVuZ3RoO1xuICAgIGlmIChsZW5EaWZmICE9IDApIHJldHVybiBsZW5EaWZmO1xuICAgIHZhciBhUG9zID0gYS5maW5kKCksIGJQb3MgPSBiLmZpbmQoKTtcbiAgICB2YXIgZnJvbUNtcCA9IGNtcChhUG9zLmZyb20sIGJQb3MuZnJvbSkgfHwgZXh0cmFMZWZ0KGEpIC0gZXh0cmFMZWZ0KGIpO1xuICAgIGlmIChmcm9tQ21wKSByZXR1cm4gLWZyb21DbXA7XG4gICAgdmFyIHRvQ21wID0gY21wKGFQb3MudG8sIGJQb3MudG8pIHx8IGV4dHJhUmlnaHQoYSkgLSBleHRyYVJpZ2h0KGIpO1xuICAgIGlmICh0b0NtcCkgcmV0dXJuIHRvQ21wO1xuICAgIHJldHVybiBiLmlkIC0gYS5pZDtcbiAgfVxuXG4gIC8vIEZpbmQgb3V0IHdoZXRoZXIgYSBsaW5lIGVuZHMgb3Igc3RhcnRzIGluIGEgY29sbGFwc2VkIHNwYW4uIElmXG4gIC8vIHNvLCByZXR1cm4gdGhlIG1hcmtlciBmb3IgdGhhdCBzcGFuLlxuICBmdW5jdGlvbiBjb2xsYXBzZWRTcGFuQXRTaWRlKGxpbmUsIHN0YXJ0KSB7XG4gICAgdmFyIHNwcyA9IHNhd0NvbGxhcHNlZFNwYW5zICYmIGxpbmUubWFya2VkU3BhbnMsIGZvdW5kO1xuICAgIGlmIChzcHMpIGZvciAodmFyIHNwLCBpID0gMDsgaSA8IHNwcy5sZW5ndGg7ICsraSkge1xuICAgICAgc3AgPSBzcHNbaV07XG4gICAgICBpZiAoc3AubWFya2VyLmNvbGxhcHNlZCAmJiAoc3RhcnQgPyBzcC5mcm9tIDogc3AudG8pID09IG51bGwgJiZcbiAgICAgICAgICAoIWZvdW5kIHx8IGNvbXBhcmVDb2xsYXBzZWRNYXJrZXJzKGZvdW5kLCBzcC5tYXJrZXIpIDwgMCkpXG4gICAgICAgIGZvdW5kID0gc3AubWFya2VyO1xuICAgIH1cbiAgICByZXR1cm4gZm91bmQ7XG4gIH1cbiAgZnVuY3Rpb24gY29sbGFwc2VkU3BhbkF0U3RhcnQobGluZSkgeyByZXR1cm4gY29sbGFwc2VkU3BhbkF0U2lkZShsaW5lLCB0cnVlKTsgfVxuICBmdW5jdGlvbiBjb2xsYXBzZWRTcGFuQXRFbmQobGluZSkgeyByZXR1cm4gY29sbGFwc2VkU3BhbkF0U2lkZShsaW5lLCBmYWxzZSk7IH1cblxuICAvLyBUZXN0IHdoZXRoZXIgdGhlcmUgZXhpc3RzIGEgY29sbGFwc2VkIHNwYW4gdGhhdCBwYXJ0aWFsbHlcbiAgLy8gb3ZlcmxhcHMgKGNvdmVycyB0aGUgc3RhcnQgb3IgZW5kLCBidXQgbm90IGJvdGgpIG9mIGEgbmV3IHNwYW4uXG4gIC8vIFN1Y2ggb3ZlcmxhcCBpcyBub3QgYWxsb3dlZC5cbiAgZnVuY3Rpb24gY29uZmxpY3RpbmdDb2xsYXBzZWRSYW5nZShkb2MsIGxpbmVObywgZnJvbSwgdG8sIG1hcmtlcikge1xuICAgIHZhciBsaW5lID0gZ2V0TGluZShkb2MsIGxpbmVObyk7XG4gICAgdmFyIHNwcyA9IHNhd0NvbGxhcHNlZFNwYW5zICYmIGxpbmUubWFya2VkU3BhbnM7XG4gICAgaWYgKHNwcykgZm9yICh2YXIgaSA9IDA7IGkgPCBzcHMubGVuZ3RoOyArK2kpIHtcbiAgICAgIHZhciBzcCA9IHNwc1tpXTtcbiAgICAgIGlmICghc3AubWFya2VyLmNvbGxhcHNlZCkgY29udGludWU7XG4gICAgICB2YXIgZm91bmQgPSBzcC5tYXJrZXIuZmluZCgwKTtcbiAgICAgIHZhciBmcm9tQ21wID0gY21wKGZvdW5kLmZyb20sIGZyb20pIHx8IGV4dHJhTGVmdChzcC5tYXJrZXIpIC0gZXh0cmFMZWZ0KG1hcmtlcik7XG4gICAgICB2YXIgdG9DbXAgPSBjbXAoZm91bmQudG8sIHRvKSB8fCBleHRyYVJpZ2h0KHNwLm1hcmtlcikgLSBleHRyYVJpZ2h0KG1hcmtlcik7XG4gICAgICBpZiAoZnJvbUNtcCA+PSAwICYmIHRvQ21wIDw9IDAgfHwgZnJvbUNtcCA8PSAwICYmIHRvQ21wID49IDApIGNvbnRpbnVlO1xuICAgICAgaWYgKGZyb21DbXAgPD0gMCAmJiAoY21wKGZvdW5kLnRvLCBmcm9tKSA+IDAgfHwgKHNwLm1hcmtlci5pbmNsdXNpdmVSaWdodCAmJiBtYXJrZXIuaW5jbHVzaXZlTGVmdCkpIHx8XG4gICAgICAgICAgZnJvbUNtcCA+PSAwICYmIChjbXAoZm91bmQuZnJvbSwgdG8pIDwgMCB8fCAoc3AubWFya2VyLmluY2x1c2l2ZUxlZnQgJiYgbWFya2VyLmluY2x1c2l2ZVJpZ2h0KSkpXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfVxuXG4gIC8vIEEgdmlzdWFsIGxpbmUgaXMgYSBsaW5lIGFzIGRyYXduIG9uIHRoZSBzY3JlZW4uIEZvbGRpbmcsIGZvclxuICAvLyBleGFtcGxlLCBjYW4gY2F1c2UgbXVsdGlwbGUgbG9naWNhbCBsaW5lcyB0byBhcHBlYXIgb24gdGhlIHNhbWVcbiAgLy8gdmlzdWFsIGxpbmUuIFRoaXMgZmluZHMgdGhlIHN0YXJ0IG9mIHRoZSB2aXN1YWwgbGluZSB0aGF0IHRoZVxuICAvLyBnaXZlbiBsaW5lIGlzIHBhcnQgb2YgKHVzdWFsbHkgdGhhdCBpcyB0aGUgbGluZSBpdHNlbGYpLlxuICBmdW5jdGlvbiB2aXN1YWxMaW5lKGxpbmUpIHtcbiAgICB2YXIgbWVyZ2VkO1xuICAgIHdoaWxlIChtZXJnZWQgPSBjb2xsYXBzZWRTcGFuQXRTdGFydChsaW5lKSlcbiAgICAgIGxpbmUgPSBtZXJnZWQuZmluZCgtMSwgdHJ1ZSkubGluZTtcbiAgICByZXR1cm4gbGluZTtcbiAgfVxuXG4gIC8vIFJldHVybnMgYW4gYXJyYXkgb2YgbG9naWNhbCBsaW5lcyB0aGF0IGNvbnRpbnVlIHRoZSB2aXN1YWwgbGluZVxuICAvLyBzdGFydGVkIGJ5IHRoZSBhcmd1bWVudCwgb3IgdW5kZWZpbmVkIGlmIHRoZXJlIGFyZSBubyBzdWNoIGxpbmVzLlxuICBmdW5jdGlvbiB2aXN1YWxMaW5lQ29udGludWVkKGxpbmUpIHtcbiAgICB2YXIgbWVyZ2VkLCBsaW5lcztcbiAgICB3aGlsZSAobWVyZ2VkID0gY29sbGFwc2VkU3BhbkF0RW5kKGxpbmUpKSB7XG4gICAgICBsaW5lID0gbWVyZ2VkLmZpbmQoMSwgdHJ1ZSkubGluZTtcbiAgICAgIChsaW5lcyB8fCAobGluZXMgPSBbXSkpLnB1c2gobGluZSk7XG4gICAgfVxuICAgIHJldHVybiBsaW5lcztcbiAgfVxuXG4gIC8vIEdldCB0aGUgbGluZSBudW1iZXIgb2YgdGhlIHN0YXJ0IG9mIHRoZSB2aXN1YWwgbGluZSB0aGF0IHRoZVxuICAvLyBnaXZlbiBsaW5lIG51bWJlciBpcyBwYXJ0IG9mLlxuICBmdW5jdGlvbiB2aXN1YWxMaW5lTm8oZG9jLCBsaW5lTikge1xuICAgIHZhciBsaW5lID0gZ2V0TGluZShkb2MsIGxpbmVOKSwgdmlzID0gdmlzdWFsTGluZShsaW5lKTtcbiAgICBpZiAobGluZSA9PSB2aXMpIHJldHVybiBsaW5lTjtcbiAgICByZXR1cm4gbGluZU5vKHZpcyk7XG4gIH1cbiAgLy8gR2V0IHRoZSBsaW5lIG51bWJlciBvZiB0aGUgc3RhcnQgb2YgdGhlIG5leHQgdmlzdWFsIGxpbmUgYWZ0ZXJcbiAgLy8gdGhlIGdpdmVuIGxpbmUuXG4gIGZ1bmN0aW9uIHZpc3VhbExpbmVFbmRObyhkb2MsIGxpbmVOKSB7XG4gICAgaWYgKGxpbmVOID4gZG9jLmxhc3RMaW5lKCkpIHJldHVybiBsaW5lTjtcbiAgICB2YXIgbGluZSA9IGdldExpbmUoZG9jLCBsaW5lTiksIG1lcmdlZDtcbiAgICBpZiAoIWxpbmVJc0hpZGRlbihkb2MsIGxpbmUpKSByZXR1cm4gbGluZU47XG4gICAgd2hpbGUgKG1lcmdlZCA9IGNvbGxhcHNlZFNwYW5BdEVuZChsaW5lKSlcbiAgICAgIGxpbmUgPSBtZXJnZWQuZmluZCgxLCB0cnVlKS5saW5lO1xuICAgIHJldHVybiBsaW5lTm8obGluZSkgKyAxO1xuICB9XG5cbiAgLy8gQ29tcHV0ZSB3aGV0aGVyIGEgbGluZSBpcyBoaWRkZW4uIExpbmVzIGNvdW50IGFzIGhpZGRlbiB3aGVuIHRoZXlcbiAgLy8gYXJlIHBhcnQgb2YgYSB2aXN1YWwgbGluZSB0aGF0IHN0YXJ0cyB3aXRoIGFub3RoZXIgbGluZSwgb3Igd2hlblxuICAvLyB0aGV5IGFyZSBlbnRpcmVseSBjb3ZlcmVkIGJ5IGNvbGxhcHNlZCwgbm9uLXdpZGdldCBzcGFuLlxuICBmdW5jdGlvbiBsaW5lSXNIaWRkZW4oZG9jLCBsaW5lKSB7XG4gICAgdmFyIHNwcyA9IHNhd0NvbGxhcHNlZFNwYW5zICYmIGxpbmUubWFya2VkU3BhbnM7XG4gICAgaWYgKHNwcykgZm9yICh2YXIgc3AsIGkgPSAwOyBpIDwgc3BzLmxlbmd0aDsgKytpKSB7XG4gICAgICBzcCA9IHNwc1tpXTtcbiAgICAgIGlmICghc3AubWFya2VyLmNvbGxhcHNlZCkgY29udGludWU7XG4gICAgICBpZiAoc3AuZnJvbSA9PSBudWxsKSByZXR1cm4gdHJ1ZTtcbiAgICAgIGlmIChzcC5tYXJrZXIud2lkZ2V0Tm9kZSkgY29udGludWU7XG4gICAgICBpZiAoc3AuZnJvbSA9PSAwICYmIHNwLm1hcmtlci5pbmNsdXNpdmVMZWZ0ICYmIGxpbmVJc0hpZGRlbklubmVyKGRvYywgbGluZSwgc3ApKVxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gIH1cbiAgZnVuY3Rpb24gbGluZUlzSGlkZGVuSW5uZXIoZG9jLCBsaW5lLCBzcGFuKSB7XG4gICAgaWYgKHNwYW4udG8gPT0gbnVsbCkge1xuICAgICAgdmFyIGVuZCA9IHNwYW4ubWFya2VyLmZpbmQoMSwgdHJ1ZSk7XG4gICAgICByZXR1cm4gbGluZUlzSGlkZGVuSW5uZXIoZG9jLCBlbmQubGluZSwgZ2V0TWFya2VkU3BhbkZvcihlbmQubGluZS5tYXJrZWRTcGFucywgc3Bhbi5tYXJrZXIpKTtcbiAgICB9XG4gICAgaWYgKHNwYW4ubWFya2VyLmluY2x1c2l2ZVJpZ2h0ICYmIHNwYW4udG8gPT0gbGluZS50ZXh0Lmxlbmd0aClcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIGZvciAodmFyIHNwLCBpID0gMDsgaSA8IGxpbmUubWFya2VkU3BhbnMubGVuZ3RoOyArK2kpIHtcbiAgICAgIHNwID0gbGluZS5tYXJrZWRTcGFuc1tpXTtcbiAgICAgIGlmIChzcC5tYXJrZXIuY29sbGFwc2VkICYmICFzcC5tYXJrZXIud2lkZ2V0Tm9kZSAmJiBzcC5mcm9tID09IHNwYW4udG8gJiZcbiAgICAgICAgICAoc3AudG8gPT0gbnVsbCB8fCBzcC50byAhPSBzcGFuLmZyb20pICYmXG4gICAgICAgICAgKHNwLm1hcmtlci5pbmNsdXNpdmVMZWZ0IHx8IHNwYW4ubWFya2VyLmluY2x1c2l2ZVJpZ2h0KSAmJlxuICAgICAgICAgIGxpbmVJc0hpZGRlbklubmVyKGRvYywgbGluZSwgc3ApKSByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gIH1cblxuICAvLyBMSU5FIFdJREdFVFNcblxuICAvLyBMaW5lIHdpZGdldHMgYXJlIGJsb2NrIGVsZW1lbnRzIGRpc3BsYXllZCBhYm92ZSBvciBiZWxvdyBhIGxpbmUuXG5cbiAgdmFyIExpbmVXaWRnZXQgPSBDb2RlTWlycm9yLkxpbmVXaWRnZXQgPSBmdW5jdGlvbihjbSwgbm9kZSwgb3B0aW9ucykge1xuICAgIGlmIChvcHRpb25zKSBmb3IgKHZhciBvcHQgaW4gb3B0aW9ucykgaWYgKG9wdGlvbnMuaGFzT3duUHJvcGVydHkob3B0KSlcbiAgICAgIHRoaXNbb3B0XSA9IG9wdGlvbnNbb3B0XTtcbiAgICB0aGlzLmNtID0gY207XG4gICAgdGhpcy5ub2RlID0gbm9kZTtcbiAgfTtcbiAgZXZlbnRNaXhpbihMaW5lV2lkZ2V0KTtcblxuICBmdW5jdGlvbiBhZGp1c3RTY3JvbGxXaGVuQWJvdmVWaXNpYmxlKGNtLCBsaW5lLCBkaWZmKSB7XG4gICAgaWYgKGhlaWdodEF0TGluZShsaW5lKSA8ICgoY20uY3VyT3AgJiYgY20uY3VyT3Auc2Nyb2xsVG9wKSB8fCBjbS5kb2Muc2Nyb2xsVG9wKSlcbiAgICAgIGFkZFRvU2Nyb2xsUG9zKGNtLCBudWxsLCBkaWZmKTtcbiAgfVxuXG4gIExpbmVXaWRnZXQucHJvdG90eXBlLmNsZWFyID0gZnVuY3Rpb24oKSB7XG4gICAgdmFyIGNtID0gdGhpcy5jbSwgd3MgPSB0aGlzLmxpbmUud2lkZ2V0cywgbGluZSA9IHRoaXMubGluZSwgbm8gPSBsaW5lTm8obGluZSk7XG4gICAgaWYgKG5vID09IG51bGwgfHwgIXdzKSByZXR1cm47XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCB3cy5sZW5ndGg7ICsraSkgaWYgKHdzW2ldID09IHRoaXMpIHdzLnNwbGljZShpLS0sIDEpO1xuICAgIGlmICghd3MubGVuZ3RoKSBsaW5lLndpZGdldHMgPSBudWxsO1xuICAgIHZhciBoZWlnaHQgPSB3aWRnZXRIZWlnaHQodGhpcyk7XG4gICAgcnVuSW5PcChjbSwgZnVuY3Rpb24oKSB7XG4gICAgICBhZGp1c3RTY3JvbGxXaGVuQWJvdmVWaXNpYmxlKGNtLCBsaW5lLCAtaGVpZ2h0KTtcbiAgICAgIHJlZ0xpbmVDaGFuZ2UoY20sIG5vLCBcIndpZGdldFwiKTtcbiAgICAgIHVwZGF0ZUxpbmVIZWlnaHQobGluZSwgTWF0aC5tYXgoMCwgbGluZS5oZWlnaHQgLSBoZWlnaHQpKTtcbiAgICB9KTtcbiAgfTtcbiAgTGluZVdpZGdldC5wcm90b3R5cGUuY2hhbmdlZCA9IGZ1bmN0aW9uKCkge1xuICAgIHZhciBvbGRIID0gdGhpcy5oZWlnaHQsIGNtID0gdGhpcy5jbSwgbGluZSA9IHRoaXMubGluZTtcbiAgICB0aGlzLmhlaWdodCA9IG51bGw7XG4gICAgdmFyIGRpZmYgPSB3aWRnZXRIZWlnaHQodGhpcykgLSBvbGRIO1xuICAgIGlmICghZGlmZikgcmV0dXJuO1xuICAgIHJ1bkluT3AoY20sIGZ1bmN0aW9uKCkge1xuICAgICAgY20uY3VyT3AuZm9yY2VVcGRhdGUgPSB0cnVlO1xuICAgICAgYWRqdXN0U2Nyb2xsV2hlbkFib3ZlVmlzaWJsZShjbSwgbGluZSwgZGlmZik7XG4gICAgICB1cGRhdGVMaW5lSGVpZ2h0KGxpbmUsIGxpbmUuaGVpZ2h0ICsgZGlmZik7XG4gICAgfSk7XG4gIH07XG5cbiAgZnVuY3Rpb24gd2lkZ2V0SGVpZ2h0KHdpZGdldCkge1xuICAgIGlmICh3aWRnZXQuaGVpZ2h0ICE9IG51bGwpIHJldHVybiB3aWRnZXQuaGVpZ2h0O1xuICAgIGlmICghY29udGFpbnMoZG9jdW1lbnQuYm9keSwgd2lkZ2V0Lm5vZGUpKSB7XG4gICAgICB2YXIgcGFyZW50U3R5bGUgPSBcInBvc2l0aW9uOiByZWxhdGl2ZTtcIjtcbiAgICAgIGlmICh3aWRnZXQuY292ZXJHdXR0ZXIpXG4gICAgICAgIHBhcmVudFN0eWxlICs9IFwibWFyZ2luLWxlZnQ6IC1cIiArIHdpZGdldC5jbS5nZXRHdXR0ZXJFbGVtZW50KCkub2Zmc2V0V2lkdGggKyBcInB4O1wiO1xuICAgICAgcmVtb3ZlQ2hpbGRyZW5BbmRBZGQod2lkZ2V0LmNtLmRpc3BsYXkubWVhc3VyZSwgZWx0KFwiZGl2XCIsIFt3aWRnZXQubm9kZV0sIG51bGwsIHBhcmVudFN0eWxlKSk7XG4gICAgfVxuICAgIHJldHVybiB3aWRnZXQuaGVpZ2h0ID0gd2lkZ2V0Lm5vZGUub2Zmc2V0SGVpZ2h0O1xuICB9XG5cbiAgZnVuY3Rpb24gYWRkTGluZVdpZGdldChjbSwgaGFuZGxlLCBub2RlLCBvcHRpb25zKSB7XG4gICAgdmFyIHdpZGdldCA9IG5ldyBMaW5lV2lkZ2V0KGNtLCBub2RlLCBvcHRpb25zKTtcbiAgICBpZiAod2lkZ2V0Lm5vSFNjcm9sbCkgY20uZGlzcGxheS5hbGlnbldpZGdldHMgPSB0cnVlO1xuICAgIGNoYW5nZUxpbmUoY20uZG9jLCBoYW5kbGUsIFwid2lkZ2V0XCIsIGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgIHZhciB3aWRnZXRzID0gbGluZS53aWRnZXRzIHx8IChsaW5lLndpZGdldHMgPSBbXSk7XG4gICAgICBpZiAod2lkZ2V0Lmluc2VydEF0ID09IG51bGwpIHdpZGdldHMucHVzaCh3aWRnZXQpO1xuICAgICAgZWxzZSB3aWRnZXRzLnNwbGljZShNYXRoLm1pbih3aWRnZXRzLmxlbmd0aCAtIDEsIE1hdGgubWF4KDAsIHdpZGdldC5pbnNlcnRBdCkpLCAwLCB3aWRnZXQpO1xuICAgICAgd2lkZ2V0LmxpbmUgPSBsaW5lO1xuICAgICAgaWYgKCFsaW5lSXNIaWRkZW4oY20uZG9jLCBsaW5lKSkge1xuICAgICAgICB2YXIgYWJvdmVWaXNpYmxlID0gaGVpZ2h0QXRMaW5lKGxpbmUpIDwgY20uZG9jLnNjcm9sbFRvcDtcbiAgICAgICAgdXBkYXRlTGluZUhlaWdodChsaW5lLCBsaW5lLmhlaWdodCArIHdpZGdldEhlaWdodCh3aWRnZXQpKTtcbiAgICAgICAgaWYgKGFib3ZlVmlzaWJsZSkgYWRkVG9TY3JvbGxQb3MoY20sIG51bGwsIHdpZGdldC5oZWlnaHQpO1xuICAgICAgICBjbS5jdXJPcC5mb3JjZVVwZGF0ZSA9IHRydWU7XG4gICAgICB9XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9KTtcbiAgICByZXR1cm4gd2lkZ2V0O1xuICB9XG5cbiAgLy8gTElORSBEQVRBIFNUUlVDVFVSRVxuXG4gIC8vIExpbmUgb2JqZWN0cy4gVGhlc2UgaG9sZCBzdGF0ZSByZWxhdGVkIHRvIGEgbGluZSwgaW5jbHVkaW5nXG4gIC8vIGhpZ2hsaWdodGluZyBpbmZvICh0aGUgc3R5bGVzIGFycmF5KS5cbiAgdmFyIExpbmUgPSBDb2RlTWlycm9yLkxpbmUgPSBmdW5jdGlvbih0ZXh0LCBtYXJrZWRTcGFucywgZXN0aW1hdGVIZWlnaHQpIHtcbiAgICB0aGlzLnRleHQgPSB0ZXh0O1xuICAgIGF0dGFjaE1hcmtlZFNwYW5zKHRoaXMsIG1hcmtlZFNwYW5zKTtcbiAgICB0aGlzLmhlaWdodCA9IGVzdGltYXRlSGVpZ2h0ID8gZXN0aW1hdGVIZWlnaHQodGhpcykgOiAxO1xuICB9O1xuICBldmVudE1peGluKExpbmUpO1xuICBMaW5lLnByb3RvdHlwZS5saW5lTm8gPSBmdW5jdGlvbigpIHsgcmV0dXJuIGxpbmVObyh0aGlzKTsgfTtcblxuICAvLyBDaGFuZ2UgdGhlIGNvbnRlbnQgKHRleHQsIG1hcmtlcnMpIG9mIGEgbGluZS4gQXV0b21hdGljYWxseVxuICAvLyBpbnZhbGlkYXRlcyBjYWNoZWQgaW5mb3JtYXRpb24gYW5kIHRyaWVzIHRvIHJlLWVzdGltYXRlIHRoZVxuICAvLyBsaW5lJ3MgaGVpZ2h0LlxuICBmdW5jdGlvbiB1cGRhdGVMaW5lKGxpbmUsIHRleHQsIG1hcmtlZFNwYW5zLCBlc3RpbWF0ZUhlaWdodCkge1xuICAgIGxpbmUudGV4dCA9IHRleHQ7XG4gICAgaWYgKGxpbmUuc3RhdGVBZnRlcikgbGluZS5zdGF0ZUFmdGVyID0gbnVsbDtcbiAgICBpZiAobGluZS5zdHlsZXMpIGxpbmUuc3R5bGVzID0gbnVsbDtcbiAgICBpZiAobGluZS5vcmRlciAhPSBudWxsKSBsaW5lLm9yZGVyID0gbnVsbDtcbiAgICBkZXRhY2hNYXJrZWRTcGFucyhsaW5lKTtcbiAgICBhdHRhY2hNYXJrZWRTcGFucyhsaW5lLCBtYXJrZWRTcGFucyk7XG4gICAgdmFyIGVzdEhlaWdodCA9IGVzdGltYXRlSGVpZ2h0ID8gZXN0aW1hdGVIZWlnaHQobGluZSkgOiAxO1xuICAgIGlmIChlc3RIZWlnaHQgIT0gbGluZS5oZWlnaHQpIHVwZGF0ZUxpbmVIZWlnaHQobGluZSwgZXN0SGVpZ2h0KTtcbiAgfVxuXG4gIC8vIERldGFjaCBhIGxpbmUgZnJvbSB0aGUgZG9jdW1lbnQgdHJlZSBhbmQgaXRzIG1hcmtlcnMuXG4gIGZ1bmN0aW9uIGNsZWFuVXBMaW5lKGxpbmUpIHtcbiAgICBsaW5lLnBhcmVudCA9IG51bGw7XG4gICAgZGV0YWNoTWFya2VkU3BhbnMobGluZSk7XG4gIH1cblxuICBmdW5jdGlvbiBleHRyYWN0TGluZUNsYXNzZXModHlwZSwgb3V0cHV0KSB7XG4gICAgaWYgKHR5cGUpIGZvciAoOzspIHtcbiAgICAgIHZhciBsaW5lQ2xhc3MgPSB0eXBlLm1hdGNoKC8oPzpefFxccyspbGluZS0oYmFja2dyb3VuZC0pPyhcXFMrKS8pO1xuICAgICAgaWYgKCFsaW5lQ2xhc3MpIGJyZWFrO1xuICAgICAgdHlwZSA9IHR5cGUuc2xpY2UoMCwgbGluZUNsYXNzLmluZGV4KSArIHR5cGUuc2xpY2UobGluZUNsYXNzLmluZGV4ICsgbGluZUNsYXNzWzBdLmxlbmd0aCk7XG4gICAgICB2YXIgcHJvcCA9IGxpbmVDbGFzc1sxXSA/IFwiYmdDbGFzc1wiIDogXCJ0ZXh0Q2xhc3NcIjtcbiAgICAgIGlmIChvdXRwdXRbcHJvcF0gPT0gbnVsbClcbiAgICAgICAgb3V0cHV0W3Byb3BdID0gbGluZUNsYXNzWzJdO1xuICAgICAgZWxzZSBpZiAoIShuZXcgUmVnRXhwKFwiKD86XnxcXHMpXCIgKyBsaW5lQ2xhc3NbMl0gKyBcIig/OiR8XFxzKVwiKSkudGVzdChvdXRwdXRbcHJvcF0pKVxuICAgICAgICBvdXRwdXRbcHJvcF0gKz0gXCIgXCIgKyBsaW5lQ2xhc3NbMl07XG4gICAgfVxuICAgIHJldHVybiB0eXBlO1xuICB9XG5cbiAgZnVuY3Rpb24gY2FsbEJsYW5rTGluZShtb2RlLCBzdGF0ZSkge1xuICAgIGlmIChtb2RlLmJsYW5rTGluZSkgcmV0dXJuIG1vZGUuYmxhbmtMaW5lKHN0YXRlKTtcbiAgICBpZiAoIW1vZGUuaW5uZXJNb2RlKSByZXR1cm47XG4gICAgdmFyIGlubmVyID0gQ29kZU1pcnJvci5pbm5lck1vZGUobW9kZSwgc3RhdGUpO1xuICAgIGlmIChpbm5lci5tb2RlLmJsYW5rTGluZSkgcmV0dXJuIGlubmVyLm1vZGUuYmxhbmtMaW5lKGlubmVyLnN0YXRlKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHJlYWRUb2tlbihtb2RlLCBzdHJlYW0sIHN0YXRlKSB7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCAxMDsgaSsrKSB7XG4gICAgICB2YXIgc3R5bGUgPSBtb2RlLnRva2VuKHN0cmVhbSwgc3RhdGUpO1xuICAgICAgaWYgKHN0cmVhbS5wb3MgPiBzdHJlYW0uc3RhcnQpIHJldHVybiBzdHlsZTtcbiAgICB9XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTW9kZSBcIiArIG1vZGUubmFtZSArIFwiIGZhaWxlZCB0byBhZHZhbmNlIHN0cmVhbS5cIik7XG4gIH1cblxuICAvLyBSdW4gdGhlIGdpdmVuIG1vZGUncyBwYXJzZXIgb3ZlciBhIGxpbmUsIGNhbGxpbmcgZiBmb3IgZWFjaCB0b2tlbi5cbiAgZnVuY3Rpb24gcnVuTW9kZShjbSwgdGV4dCwgbW9kZSwgc3RhdGUsIGYsIGxpbmVDbGFzc2VzLCBmb3JjZVRvRW5kKSB7XG4gICAgdmFyIGZsYXR0ZW5TcGFucyA9IG1vZGUuZmxhdHRlblNwYW5zO1xuICAgIGlmIChmbGF0dGVuU3BhbnMgPT0gbnVsbCkgZmxhdHRlblNwYW5zID0gY20ub3B0aW9ucy5mbGF0dGVuU3BhbnM7XG4gICAgdmFyIGN1clN0YXJ0ID0gMCwgY3VyU3R5bGUgPSBudWxsO1xuICAgIHZhciBzdHJlYW0gPSBuZXcgU3RyaW5nU3RyZWFtKHRleHQsIGNtLm9wdGlvbnMudGFiU2l6ZSksIHN0eWxlO1xuICAgIGlmICh0ZXh0ID09IFwiXCIpIGV4dHJhY3RMaW5lQ2xhc3NlcyhjYWxsQmxhbmtMaW5lKG1vZGUsIHN0YXRlKSwgbGluZUNsYXNzZXMpO1xuICAgIHdoaWxlICghc3RyZWFtLmVvbCgpKSB7XG4gICAgICBpZiAoc3RyZWFtLnBvcyA+IGNtLm9wdGlvbnMubWF4SGlnaGxpZ2h0TGVuZ3RoKSB7XG4gICAgICAgIGZsYXR0ZW5TcGFucyA9IGZhbHNlO1xuICAgICAgICBpZiAoZm9yY2VUb0VuZCkgcHJvY2Vzc0xpbmUoY20sIHRleHQsIHN0YXRlLCBzdHJlYW0ucG9zKTtcbiAgICAgICAgc3RyZWFtLnBvcyA9IHRleHQubGVuZ3RoO1xuICAgICAgICBzdHlsZSA9IG51bGw7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzdHlsZSA9IGV4dHJhY3RMaW5lQ2xhc3NlcyhyZWFkVG9rZW4obW9kZSwgc3RyZWFtLCBzdGF0ZSksIGxpbmVDbGFzc2VzKTtcbiAgICAgIH1cbiAgICAgIGlmIChjbS5vcHRpb25zLmFkZE1vZGVDbGFzcykge1xuICAgICAgICB2YXIgbU5hbWUgPSBDb2RlTWlycm9yLmlubmVyTW9kZShtb2RlLCBzdGF0ZSkubW9kZS5uYW1lO1xuICAgICAgICBpZiAobU5hbWUpIHN0eWxlID0gXCJtLVwiICsgKHN0eWxlID8gbU5hbWUgKyBcIiBcIiArIHN0eWxlIDogbU5hbWUpO1xuICAgICAgfVxuICAgICAgaWYgKCFmbGF0dGVuU3BhbnMgfHwgY3VyU3R5bGUgIT0gc3R5bGUpIHtcbiAgICAgICAgaWYgKGN1clN0YXJ0IDwgc3RyZWFtLnN0YXJ0KSBmKHN0cmVhbS5zdGFydCwgY3VyU3R5bGUpO1xuICAgICAgICBjdXJTdGFydCA9IHN0cmVhbS5zdGFydDsgY3VyU3R5bGUgPSBzdHlsZTtcbiAgICAgIH1cbiAgICAgIHN0cmVhbS5zdGFydCA9IHN0cmVhbS5wb3M7XG4gICAgfVxuICAgIHdoaWxlIChjdXJTdGFydCA8IHN0cmVhbS5wb3MpIHtcbiAgICAgIC8vIFdlYmtpdCBzZWVtcyB0byByZWZ1c2UgdG8gcmVuZGVyIHRleHQgbm9kZXMgbG9uZ2VyIHRoYW4gNTc0NDQgY2hhcmFjdGVyc1xuICAgICAgdmFyIHBvcyA9IE1hdGgubWluKHN0cmVhbS5wb3MsIGN1clN0YXJ0ICsgNTAwMDApO1xuICAgICAgZihwb3MsIGN1clN0eWxlKTtcbiAgICAgIGN1clN0YXJ0ID0gcG9zO1xuICAgIH1cbiAgfVxuXG4gIC8vIENvbXB1dGUgYSBzdHlsZSBhcnJheSAoYW4gYXJyYXkgc3RhcnRpbmcgd2l0aCBhIG1vZGUgZ2VuZXJhdGlvblxuICAvLyAtLSBmb3IgaW52YWxpZGF0aW9uIC0tIGZvbGxvd2VkIGJ5IHBhaXJzIG9mIGVuZCBwb3NpdGlvbnMgYW5kXG4gIC8vIHN0eWxlIHN0cmluZ3MpLCB3aGljaCBpcyB1c2VkIHRvIGhpZ2hsaWdodCB0aGUgdG9rZW5zIG9uIHRoZVxuICAvLyBsaW5lLlxuICBmdW5jdGlvbiBoaWdobGlnaHRMaW5lKGNtLCBsaW5lLCBzdGF0ZSwgZm9yY2VUb0VuZCkge1xuICAgIC8vIEEgc3R5bGVzIGFycmF5IGFsd2F5cyBzdGFydHMgd2l0aCBhIG51bWJlciBpZGVudGlmeWluZyB0aGVcbiAgICAvLyBtb2RlL292ZXJsYXlzIHRoYXQgaXQgaXMgYmFzZWQgb24gKGZvciBlYXN5IGludmFsaWRhdGlvbikuXG4gICAgdmFyIHN0ID0gW2NtLnN0YXRlLm1vZGVHZW5dLCBsaW5lQ2xhc3NlcyA9IHt9O1xuICAgIC8vIENvbXB1dGUgdGhlIGJhc2UgYXJyYXkgb2Ygc3R5bGVzXG4gICAgcnVuTW9kZShjbSwgbGluZS50ZXh0LCBjbS5kb2MubW9kZSwgc3RhdGUsIGZ1bmN0aW9uKGVuZCwgc3R5bGUpIHtcbiAgICAgIHN0LnB1c2goZW5kLCBzdHlsZSk7XG4gICAgfSwgbGluZUNsYXNzZXMsIGZvcmNlVG9FbmQpO1xuXG4gICAgLy8gUnVuIG92ZXJsYXlzLCBhZGp1c3Qgc3R5bGUgYXJyYXkuXG4gICAgZm9yICh2YXIgbyA9IDA7IG8gPCBjbS5zdGF0ZS5vdmVybGF5cy5sZW5ndGg7ICsrbykge1xuICAgICAgdmFyIG92ZXJsYXkgPSBjbS5zdGF0ZS5vdmVybGF5c1tvXSwgaSA9IDEsIGF0ID0gMDtcbiAgICAgIHJ1bk1vZGUoY20sIGxpbmUudGV4dCwgb3ZlcmxheS5tb2RlLCB0cnVlLCBmdW5jdGlvbihlbmQsIHN0eWxlKSB7XG4gICAgICAgIHZhciBzdGFydCA9IGk7XG4gICAgICAgIC8vIEVuc3VyZSB0aGVyZSdzIGEgdG9rZW4gZW5kIGF0IHRoZSBjdXJyZW50IHBvc2l0aW9uLCBhbmQgdGhhdCBpIHBvaW50cyBhdCBpdFxuICAgICAgICB3aGlsZSAoYXQgPCBlbmQpIHtcbiAgICAgICAgICB2YXIgaV9lbmQgPSBzdFtpXTtcbiAgICAgICAgICBpZiAoaV9lbmQgPiBlbmQpXG4gICAgICAgICAgICBzdC5zcGxpY2UoaSwgMSwgZW5kLCBzdFtpKzFdLCBpX2VuZCk7XG4gICAgICAgICAgaSArPSAyO1xuICAgICAgICAgIGF0ID0gTWF0aC5taW4oZW5kLCBpX2VuZCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFzdHlsZSkgcmV0dXJuO1xuICAgICAgICBpZiAob3ZlcmxheS5vcGFxdWUpIHtcbiAgICAgICAgICBzdC5zcGxpY2Uoc3RhcnQsIGkgLSBzdGFydCwgZW5kLCBcImNtLW92ZXJsYXkgXCIgKyBzdHlsZSk7XG4gICAgICAgICAgaSA9IHN0YXJ0ICsgMjtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBmb3IgKDsgc3RhcnQgPCBpOyBzdGFydCArPSAyKSB7XG4gICAgICAgICAgICB2YXIgY3VyID0gc3Rbc3RhcnQrMV07XG4gICAgICAgICAgICBzdFtzdGFydCsxXSA9IChjdXIgPyBjdXIgKyBcIiBcIiA6IFwiXCIpICsgXCJjbS1vdmVybGF5IFwiICsgc3R5bGU7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9LCBsaW5lQ2xhc3Nlcyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHtzdHlsZXM6IHN0LCBjbGFzc2VzOiBsaW5lQ2xhc3Nlcy5iZ0NsYXNzIHx8IGxpbmVDbGFzc2VzLnRleHRDbGFzcyA/IGxpbmVDbGFzc2VzIDogbnVsbH07XG4gIH1cblxuICBmdW5jdGlvbiBnZXRMaW5lU3R5bGVzKGNtLCBsaW5lKSB7XG4gICAgaWYgKCFsaW5lLnN0eWxlcyB8fCBsaW5lLnN0eWxlc1swXSAhPSBjbS5zdGF0ZS5tb2RlR2VuKSB7XG4gICAgICB2YXIgcmVzdWx0ID0gaGlnaGxpZ2h0TGluZShjbSwgbGluZSwgbGluZS5zdGF0ZUFmdGVyID0gZ2V0U3RhdGVCZWZvcmUoY20sIGxpbmVObyhsaW5lKSkpO1xuICAgICAgbGluZS5zdHlsZXMgPSByZXN1bHQuc3R5bGVzO1xuICAgICAgaWYgKHJlc3VsdC5jbGFzc2VzKSBsaW5lLnN0eWxlQ2xhc3NlcyA9IHJlc3VsdC5jbGFzc2VzO1xuICAgICAgZWxzZSBpZiAobGluZS5zdHlsZUNsYXNzZXMpIGxpbmUuc3R5bGVDbGFzc2VzID0gbnVsbDtcbiAgICB9XG4gICAgcmV0dXJuIGxpbmUuc3R5bGVzO1xuICB9XG5cbiAgLy8gTGlnaHR3ZWlnaHQgZm9ybSBvZiBoaWdobGlnaHQgLS0gcHJvY2VlZCBvdmVyIHRoaXMgbGluZSBhbmRcbiAgLy8gdXBkYXRlIHN0YXRlLCBidXQgZG9uJ3Qgc2F2ZSBhIHN0eWxlIGFycmF5LiBVc2VkIGZvciBsaW5lcyB0aGF0XG4gIC8vIGFyZW4ndCBjdXJyZW50bHkgdmlzaWJsZS5cbiAgZnVuY3Rpb24gcHJvY2Vzc0xpbmUoY20sIHRleHQsIHN0YXRlLCBzdGFydEF0KSB7XG4gICAgdmFyIG1vZGUgPSBjbS5kb2MubW9kZTtcbiAgICB2YXIgc3RyZWFtID0gbmV3IFN0cmluZ1N0cmVhbSh0ZXh0LCBjbS5vcHRpb25zLnRhYlNpemUpO1xuICAgIHN0cmVhbS5zdGFydCA9IHN0cmVhbS5wb3MgPSBzdGFydEF0IHx8IDA7XG4gICAgaWYgKHRleHQgPT0gXCJcIikgY2FsbEJsYW5rTGluZShtb2RlLCBzdGF0ZSk7XG4gICAgd2hpbGUgKCFzdHJlYW0uZW9sKCkgJiYgc3RyZWFtLnBvcyA8PSBjbS5vcHRpb25zLm1heEhpZ2hsaWdodExlbmd0aCkge1xuICAgICAgcmVhZFRva2VuKG1vZGUsIHN0cmVhbSwgc3RhdGUpO1xuICAgICAgc3RyZWFtLnN0YXJ0ID0gc3RyZWFtLnBvcztcbiAgICB9XG4gIH1cblxuICAvLyBDb252ZXJ0IGEgc3R5bGUgYXMgcmV0dXJuZWQgYnkgYSBtb2RlIChlaXRoZXIgbnVsbCwgb3IgYSBzdHJpbmdcbiAgLy8gY29udGFpbmluZyBvbmUgb3IgbW9yZSBzdHlsZXMpIHRvIGEgQ1NTIHN0eWxlLiBUaGlzIGlzIGNhY2hlZCxcbiAgLy8gYW5kIGFsc28gbG9va3MgZm9yIGxpbmUtd2lkZSBzdHlsZXMuXG4gIHZhciBzdHlsZVRvQ2xhc3NDYWNoZSA9IHt9LCBzdHlsZVRvQ2xhc3NDYWNoZVdpdGhNb2RlID0ge307XG4gIGZ1bmN0aW9uIGludGVycHJldFRva2VuU3R5bGUoc3R5bGUsIG9wdGlvbnMpIHtcbiAgICBpZiAoIXN0eWxlIHx8IC9eXFxzKiQvLnRlc3Qoc3R5bGUpKSByZXR1cm4gbnVsbDtcbiAgICB2YXIgY2FjaGUgPSBvcHRpb25zLmFkZE1vZGVDbGFzcyA/IHN0eWxlVG9DbGFzc0NhY2hlV2l0aE1vZGUgOiBzdHlsZVRvQ2xhc3NDYWNoZTtcbiAgICByZXR1cm4gY2FjaGVbc3R5bGVdIHx8XG4gICAgICAoY2FjaGVbc3R5bGVdID0gc3R5bGUucmVwbGFjZSgvXFxTKy9nLCBcImNtLSQmXCIpKTtcbiAgfVxuXG4gIC8vIFJlbmRlciB0aGUgRE9NIHJlcHJlc2VudGF0aW9uIG9mIHRoZSB0ZXh0IG9mIGEgbGluZS4gQWxzbyBidWlsZHNcbiAgLy8gdXAgYSAnbGluZSBtYXAnLCB3aGljaCBwb2ludHMgYXQgdGhlIERPTSBub2RlcyB0aGF0IHJlcHJlc2VudFxuICAvLyBzcGVjaWZpYyBzdHJldGNoZXMgb2YgdGV4dCwgYW5kIGlzIHVzZWQgYnkgdGhlIG1lYXN1cmluZyBjb2RlLlxuICAvLyBUaGUgcmV0dXJuZWQgb2JqZWN0IGNvbnRhaW5zIHRoZSBET00gbm9kZSwgdGhpcyBtYXAsIGFuZFxuICAvLyBpbmZvcm1hdGlvbiBhYm91dCBsaW5lLXdpZGUgc3R5bGVzIHRoYXQgd2VyZSBzZXQgYnkgdGhlIG1vZGUuXG4gIGZ1bmN0aW9uIGJ1aWxkTGluZUNvbnRlbnQoY20sIGxpbmVWaWV3KSB7XG4gICAgLy8gVGhlIHBhZGRpbmctcmlnaHQgZm9yY2VzIHRoZSBlbGVtZW50IHRvIGhhdmUgYSAnYm9yZGVyJywgd2hpY2hcbiAgICAvLyBpcyBuZWVkZWQgb24gV2Via2l0IHRvIGJlIGFibGUgdG8gZ2V0IGxpbmUtbGV2ZWwgYm91bmRpbmdcbiAgICAvLyByZWN0YW5nbGVzIGZvciBpdCAoaW4gbWVhc3VyZUNoYXIpLlxuICAgIHZhciBjb250ZW50ID0gZWx0KFwic3BhblwiLCBudWxsLCBudWxsLCB3ZWJraXQgPyBcInBhZGRpbmctcmlnaHQ6IC4xcHhcIiA6IG51bGwpO1xuICAgIHZhciBidWlsZGVyID0ge3ByZTogZWx0KFwicHJlXCIsIFtjb250ZW50XSksIGNvbnRlbnQ6IGNvbnRlbnQsIGNvbDogMCwgcG9zOiAwLCBjbTogY219O1xuICAgIGxpbmVWaWV3Lm1lYXN1cmUgPSB7fTtcblxuICAgIC8vIEl0ZXJhdGUgb3ZlciB0aGUgbG9naWNhbCBsaW5lcyB0aGF0IG1ha2UgdXAgdGhpcyB2aXN1YWwgbGluZS5cbiAgICBmb3IgKHZhciBpID0gMDsgaSA8PSAobGluZVZpZXcucmVzdCA/IGxpbmVWaWV3LnJlc3QubGVuZ3RoIDogMCk7IGkrKykge1xuICAgICAgdmFyIGxpbmUgPSBpID8gbGluZVZpZXcucmVzdFtpIC0gMV0gOiBsaW5lVmlldy5saW5lLCBvcmRlcjtcbiAgICAgIGJ1aWxkZXIucG9zID0gMDtcbiAgICAgIGJ1aWxkZXIuYWRkVG9rZW4gPSBidWlsZFRva2VuO1xuICAgICAgLy8gT3B0aW9uYWxseSB3aXJlIGluIHNvbWUgaGFja3MgaW50byB0aGUgdG9rZW4tcmVuZGVyaW5nXG4gICAgICAvLyBhbGdvcml0aG0sIHRvIGRlYWwgd2l0aCBicm93c2VyIHF1aXJrcy5cbiAgICAgIGlmICgoaWUgfHwgd2Via2l0KSAmJiBjbS5nZXRPcHRpb24oXCJsaW5lV3JhcHBpbmdcIikpXG4gICAgICAgIGJ1aWxkZXIuYWRkVG9rZW4gPSBidWlsZFRva2VuU3BsaXRTcGFjZXMoYnVpbGRlci5hZGRUb2tlbik7XG4gICAgICBpZiAoaGFzQmFkQmlkaVJlY3RzKGNtLmRpc3BsYXkubWVhc3VyZSkgJiYgKG9yZGVyID0gZ2V0T3JkZXIobGluZSkpKVxuICAgICAgICBidWlsZGVyLmFkZFRva2VuID0gYnVpbGRUb2tlbkJhZEJpZGkoYnVpbGRlci5hZGRUb2tlbiwgb3JkZXIpO1xuICAgICAgYnVpbGRlci5tYXAgPSBbXTtcbiAgICAgIGluc2VydExpbmVDb250ZW50KGxpbmUsIGJ1aWxkZXIsIGdldExpbmVTdHlsZXMoY20sIGxpbmUpKTtcbiAgICAgIGlmIChsaW5lLnN0eWxlQ2xhc3Nlcykge1xuICAgICAgICBpZiAobGluZS5zdHlsZUNsYXNzZXMuYmdDbGFzcylcbiAgICAgICAgICBidWlsZGVyLmJnQ2xhc3MgPSBqb2luQ2xhc3NlcyhsaW5lLnN0eWxlQ2xhc3Nlcy5iZ0NsYXNzLCBidWlsZGVyLmJnQ2xhc3MgfHwgXCJcIik7XG4gICAgICAgIGlmIChsaW5lLnN0eWxlQ2xhc3Nlcy50ZXh0Q2xhc3MpXG4gICAgICAgICAgYnVpbGRlci50ZXh0Q2xhc3MgPSBqb2luQ2xhc3NlcyhsaW5lLnN0eWxlQ2xhc3Nlcy50ZXh0Q2xhc3MsIGJ1aWxkZXIudGV4dENsYXNzIHx8IFwiXCIpO1xuICAgICAgfVxuXG4gICAgICAvLyBFbnN1cmUgYXQgbGVhc3QgYSBzaW5nbGUgbm9kZSBpcyBwcmVzZW50LCBmb3IgbWVhc3VyaW5nLlxuICAgICAgaWYgKGJ1aWxkZXIubWFwLmxlbmd0aCA9PSAwKVxuICAgICAgICBidWlsZGVyLm1hcC5wdXNoKDAsIDAsIGJ1aWxkZXIuY29udGVudC5hcHBlbmRDaGlsZCh6ZXJvV2lkdGhFbGVtZW50KGNtLmRpc3BsYXkubWVhc3VyZSkpKTtcblxuICAgICAgLy8gU3RvcmUgdGhlIG1hcCBhbmQgYSBjYWNoZSBvYmplY3QgZm9yIHRoZSBjdXJyZW50IGxvZ2ljYWwgbGluZVxuICAgICAgaWYgKGkgPT0gMCkge1xuICAgICAgICBsaW5lVmlldy5tZWFzdXJlLm1hcCA9IGJ1aWxkZXIubWFwO1xuICAgICAgICBsaW5lVmlldy5tZWFzdXJlLmNhY2hlID0ge307XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAobGluZVZpZXcubWVhc3VyZS5tYXBzIHx8IChsaW5lVmlldy5tZWFzdXJlLm1hcHMgPSBbXSkpLnB1c2goYnVpbGRlci5tYXApO1xuICAgICAgICAobGluZVZpZXcubWVhc3VyZS5jYWNoZXMgfHwgKGxpbmVWaWV3Lm1lYXN1cmUuY2FjaGVzID0gW10pKS5wdXNoKHt9KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBzaWduYWwoY20sIFwicmVuZGVyTGluZVwiLCBjbSwgbGluZVZpZXcubGluZSwgYnVpbGRlci5wcmUpO1xuICAgIGlmIChidWlsZGVyLnByZS5jbGFzc05hbWUpXG4gICAgICBidWlsZGVyLnRleHRDbGFzcyA9IGpvaW5DbGFzc2VzKGJ1aWxkZXIucHJlLmNsYXNzTmFtZSwgYnVpbGRlci50ZXh0Q2xhc3MgfHwgXCJcIik7XG4gICAgcmV0dXJuIGJ1aWxkZXI7XG4gIH1cblxuICBmdW5jdGlvbiBkZWZhdWx0U3BlY2lhbENoYXJQbGFjZWhvbGRlcihjaCkge1xuICAgIHZhciB0b2tlbiA9IGVsdChcInNwYW5cIiwgXCJcXHUyMDIyXCIsIFwiY20taW52YWxpZGNoYXJcIik7XG4gICAgdG9rZW4udGl0bGUgPSBcIlxcXFx1XCIgKyBjaC5jaGFyQ29kZUF0KDApLnRvU3RyaW5nKDE2KTtcbiAgICByZXR1cm4gdG9rZW47XG4gIH1cblxuICAvLyBCdWlsZCB1cCB0aGUgRE9NIHJlcHJlc2VudGF0aW9uIGZvciBhIHNpbmdsZSB0b2tlbiwgYW5kIGFkZCBpdCB0b1xuICAvLyB0aGUgbGluZSBtYXAuIFRha2VzIGNhcmUgdG8gcmVuZGVyIHNwZWNpYWwgY2hhcmFjdGVycyBzZXBhcmF0ZWx5LlxuICBmdW5jdGlvbiBidWlsZFRva2VuKGJ1aWxkZXIsIHRleHQsIHN0eWxlLCBzdGFydFN0eWxlLCBlbmRTdHlsZSwgdGl0bGUpIHtcbiAgICBpZiAoIXRleHQpIHJldHVybjtcbiAgICB2YXIgc3BlY2lhbCA9IGJ1aWxkZXIuY20ub3B0aW9ucy5zcGVjaWFsQ2hhcnMsIG11c3RXcmFwID0gZmFsc2U7XG4gICAgaWYgKCFzcGVjaWFsLnRlc3QodGV4dCkpIHtcbiAgICAgIGJ1aWxkZXIuY29sICs9IHRleHQubGVuZ3RoO1xuICAgICAgdmFyIGNvbnRlbnQgPSBkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZSh0ZXh0KTtcbiAgICAgIGJ1aWxkZXIubWFwLnB1c2goYnVpbGRlci5wb3MsIGJ1aWxkZXIucG9zICsgdGV4dC5sZW5ndGgsIGNvbnRlbnQpO1xuICAgICAgaWYgKGllICYmIGllX3ZlcnNpb24gPCA5KSBtdXN0V3JhcCA9IHRydWU7XG4gICAgICBidWlsZGVyLnBvcyArPSB0ZXh0Lmxlbmd0aDtcbiAgICB9IGVsc2Uge1xuICAgICAgdmFyIGNvbnRlbnQgPSBkb2N1bWVudC5jcmVhdGVEb2N1bWVudEZyYWdtZW50KCksIHBvcyA9IDA7XG4gICAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgICBzcGVjaWFsLmxhc3RJbmRleCA9IHBvcztcbiAgICAgICAgdmFyIG0gPSBzcGVjaWFsLmV4ZWModGV4dCk7XG4gICAgICAgIHZhciBza2lwcGVkID0gbSA/IG0uaW5kZXggLSBwb3MgOiB0ZXh0Lmxlbmd0aCAtIHBvcztcbiAgICAgICAgaWYgKHNraXBwZWQpIHtcbiAgICAgICAgICB2YXIgdHh0ID0gZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUodGV4dC5zbGljZShwb3MsIHBvcyArIHNraXBwZWQpKTtcbiAgICAgICAgICBpZiAoaWUgJiYgaWVfdmVyc2lvbiA8IDkpIGNvbnRlbnQuYXBwZW5kQ2hpbGQoZWx0KFwic3BhblwiLCBbdHh0XSkpO1xuICAgICAgICAgIGVsc2UgY29udGVudC5hcHBlbmRDaGlsZCh0eHQpO1xuICAgICAgICAgIGJ1aWxkZXIubWFwLnB1c2goYnVpbGRlci5wb3MsIGJ1aWxkZXIucG9zICsgc2tpcHBlZCwgdHh0KTtcbiAgICAgICAgICBidWlsZGVyLmNvbCArPSBza2lwcGVkO1xuICAgICAgICAgIGJ1aWxkZXIucG9zICs9IHNraXBwZWQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFtKSBicmVhaztcbiAgICAgICAgcG9zICs9IHNraXBwZWQgKyAxO1xuICAgICAgICBpZiAobVswXSA9PSBcIlxcdFwiKSB7XG4gICAgICAgICAgdmFyIHRhYlNpemUgPSBidWlsZGVyLmNtLm9wdGlvbnMudGFiU2l6ZSwgdGFiV2lkdGggPSB0YWJTaXplIC0gYnVpbGRlci5jb2wgJSB0YWJTaXplO1xuICAgICAgICAgIHZhciB0eHQgPSBjb250ZW50LmFwcGVuZENoaWxkKGVsdChcInNwYW5cIiwgc3BhY2VTdHIodGFiV2lkdGgpLCBcImNtLXRhYlwiKSk7XG4gICAgICAgICAgYnVpbGRlci5jb2wgKz0gdGFiV2lkdGg7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdmFyIHR4dCA9IGJ1aWxkZXIuY20ub3B0aW9ucy5zcGVjaWFsQ2hhclBsYWNlaG9sZGVyKG1bMF0pO1xuICAgICAgICAgIGlmIChpZSAmJiBpZV92ZXJzaW9uIDwgOSkgY29udGVudC5hcHBlbmRDaGlsZChlbHQoXCJzcGFuXCIsIFt0eHRdKSk7XG4gICAgICAgICAgZWxzZSBjb250ZW50LmFwcGVuZENoaWxkKHR4dCk7XG4gICAgICAgICAgYnVpbGRlci5jb2wgKz0gMTtcbiAgICAgICAgfVxuICAgICAgICBidWlsZGVyLm1hcC5wdXNoKGJ1aWxkZXIucG9zLCBidWlsZGVyLnBvcyArIDEsIHR4dCk7XG4gICAgICAgIGJ1aWxkZXIucG9zKys7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChzdHlsZSB8fCBzdGFydFN0eWxlIHx8IGVuZFN0eWxlIHx8IG11c3RXcmFwKSB7XG4gICAgICB2YXIgZnVsbFN0eWxlID0gc3R5bGUgfHwgXCJcIjtcbiAgICAgIGlmIChzdGFydFN0eWxlKSBmdWxsU3R5bGUgKz0gc3RhcnRTdHlsZTtcbiAgICAgIGlmIChlbmRTdHlsZSkgZnVsbFN0eWxlICs9IGVuZFN0eWxlO1xuICAgICAgdmFyIHRva2VuID0gZWx0KFwic3BhblwiLCBbY29udGVudF0sIGZ1bGxTdHlsZSk7XG4gICAgICBpZiAodGl0bGUpIHRva2VuLnRpdGxlID0gdGl0bGU7XG4gICAgICByZXR1cm4gYnVpbGRlci5jb250ZW50LmFwcGVuZENoaWxkKHRva2VuKTtcbiAgICB9XG4gICAgYnVpbGRlci5jb250ZW50LmFwcGVuZENoaWxkKGNvbnRlbnQpO1xuICB9XG5cbiAgZnVuY3Rpb24gYnVpbGRUb2tlblNwbGl0U3BhY2VzKGlubmVyKSB7XG4gICAgZnVuY3Rpb24gc3BsaXQob2xkKSB7XG4gICAgICB2YXIgb3V0ID0gXCIgXCI7XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IG9sZC5sZW5ndGggLSAyOyArK2kpIG91dCArPSBpICUgMiA/IFwiIFwiIDogXCJcXHUwMGEwXCI7XG4gICAgICBvdXQgKz0gXCIgXCI7XG4gICAgICByZXR1cm4gb3V0O1xuICAgIH1cbiAgICByZXR1cm4gZnVuY3Rpb24oYnVpbGRlciwgdGV4dCwgc3R5bGUsIHN0YXJ0U3R5bGUsIGVuZFN0eWxlLCB0aXRsZSkge1xuICAgICAgaW5uZXIoYnVpbGRlciwgdGV4dC5yZXBsYWNlKC8gezMsfS9nLCBzcGxpdCksIHN0eWxlLCBzdGFydFN0eWxlLCBlbmRTdHlsZSwgdGl0bGUpO1xuICAgIH07XG4gIH1cblxuICAvLyBXb3JrIGFyb3VuZCBub25zZW5zZSBkaW1lbnNpb25zIGJlaW5nIHJlcG9ydGVkIGZvciBzdHJldGNoZXMgb2ZcbiAgLy8gcmlnaHQtdG8tbGVmdCB0ZXh0LlxuICBmdW5jdGlvbiBidWlsZFRva2VuQmFkQmlkaShpbm5lciwgb3JkZXIpIHtcbiAgICByZXR1cm4gZnVuY3Rpb24oYnVpbGRlciwgdGV4dCwgc3R5bGUsIHN0YXJ0U3R5bGUsIGVuZFN0eWxlLCB0aXRsZSkge1xuICAgICAgc3R5bGUgPSBzdHlsZSA/IHN0eWxlICsgXCIgY20tZm9yY2UtYm9yZGVyXCIgOiBcImNtLWZvcmNlLWJvcmRlclwiO1xuICAgICAgdmFyIHN0YXJ0ID0gYnVpbGRlci5wb3MsIGVuZCA9IHN0YXJ0ICsgdGV4dC5sZW5ndGg7XG4gICAgICBmb3IgKDs7KSB7XG4gICAgICAgIC8vIEZpbmQgdGhlIHBhcnQgdGhhdCBvdmVybGFwcyB3aXRoIHRoZSBzdGFydCBvZiB0aGlzIHRleHRcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBvcmRlci5sZW5ndGg7IGkrKykge1xuICAgICAgICAgIHZhciBwYXJ0ID0gb3JkZXJbaV07XG4gICAgICAgICAgaWYgKHBhcnQudG8gPiBzdGFydCAmJiBwYXJ0LmZyb20gPD0gc3RhcnQpIGJyZWFrO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwYXJ0LnRvID49IGVuZCkgcmV0dXJuIGlubmVyKGJ1aWxkZXIsIHRleHQsIHN0eWxlLCBzdGFydFN0eWxlLCBlbmRTdHlsZSwgdGl0bGUpO1xuICAgICAgICBpbm5lcihidWlsZGVyLCB0ZXh0LnNsaWNlKDAsIHBhcnQudG8gLSBzdGFydCksIHN0eWxlLCBzdGFydFN0eWxlLCBudWxsLCB0aXRsZSk7XG4gICAgICAgIHN0YXJ0U3R5bGUgPSBudWxsO1xuICAgICAgICB0ZXh0ID0gdGV4dC5zbGljZShwYXJ0LnRvIC0gc3RhcnQpO1xuICAgICAgICBzdGFydCA9IHBhcnQudG87XG4gICAgICB9XG4gICAgfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGJ1aWxkQ29sbGFwc2VkU3BhbihidWlsZGVyLCBzaXplLCBtYXJrZXIsIGlnbm9yZVdpZGdldCkge1xuICAgIHZhciB3aWRnZXQgPSAhaWdub3JlV2lkZ2V0ICYmIG1hcmtlci53aWRnZXROb2RlO1xuICAgIGlmICh3aWRnZXQpIHtcbiAgICAgIGJ1aWxkZXIubWFwLnB1c2goYnVpbGRlci5wb3MsIGJ1aWxkZXIucG9zICsgc2l6ZSwgd2lkZ2V0KTtcbiAgICAgIGJ1aWxkZXIuY29udGVudC5hcHBlbmRDaGlsZCh3aWRnZXQpO1xuICAgIH1cbiAgICBidWlsZGVyLnBvcyArPSBzaXplO1xuICB9XG5cbiAgLy8gT3V0cHV0cyBhIG51bWJlciBvZiBzcGFucyB0byBtYWtlIHVwIGEgbGluZSwgdGFraW5nIGhpZ2hsaWdodGluZ1xuICAvLyBhbmQgbWFya2VkIHRleHQgaW50byBhY2NvdW50LlxuICBmdW5jdGlvbiBpbnNlcnRMaW5lQ29udGVudChsaW5lLCBidWlsZGVyLCBzdHlsZXMpIHtcbiAgICB2YXIgc3BhbnMgPSBsaW5lLm1hcmtlZFNwYW5zLCBhbGxUZXh0ID0gbGluZS50ZXh0LCBhdCA9IDA7XG4gICAgaWYgKCFzcGFucykge1xuICAgICAgZm9yICh2YXIgaSA9IDE7IGkgPCBzdHlsZXMubGVuZ3RoOyBpKz0yKVxuICAgICAgICBidWlsZGVyLmFkZFRva2VuKGJ1aWxkZXIsIGFsbFRleHQuc2xpY2UoYXQsIGF0ID0gc3R5bGVzW2ldKSwgaW50ZXJwcmV0VG9rZW5TdHlsZShzdHlsZXNbaSsxXSwgYnVpbGRlci5jbS5vcHRpb25zKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdmFyIGxlbiA9IGFsbFRleHQubGVuZ3RoLCBwb3MgPSAwLCBpID0gMSwgdGV4dCA9IFwiXCIsIHN0eWxlO1xuICAgIHZhciBuZXh0Q2hhbmdlID0gMCwgc3BhblN0eWxlLCBzcGFuRW5kU3R5bGUsIHNwYW5TdGFydFN0eWxlLCB0aXRsZSwgY29sbGFwc2VkO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGlmIChuZXh0Q2hhbmdlID09IHBvcykgeyAvLyBVcGRhdGUgY3VycmVudCBtYXJrZXIgc2V0XG4gICAgICAgIHNwYW5TdHlsZSA9IHNwYW5FbmRTdHlsZSA9IHNwYW5TdGFydFN0eWxlID0gdGl0bGUgPSBcIlwiO1xuICAgICAgICBjb2xsYXBzZWQgPSBudWxsOyBuZXh0Q2hhbmdlID0gSW5maW5pdHk7XG4gICAgICAgIHZhciBmb3VuZEJvb2ttYXJrcyA9IFtdO1xuICAgICAgICBmb3IgKHZhciBqID0gMDsgaiA8IHNwYW5zLmxlbmd0aDsgKytqKSB7XG4gICAgICAgICAgdmFyIHNwID0gc3BhbnNbal0sIG0gPSBzcC5tYXJrZXI7XG4gICAgICAgICAgaWYgKHNwLmZyb20gPD0gcG9zICYmIChzcC50byA9PSBudWxsIHx8IHNwLnRvID4gcG9zKSkge1xuICAgICAgICAgICAgaWYgKHNwLnRvICE9IG51bGwgJiYgbmV4dENoYW5nZSA+IHNwLnRvKSB7IG5leHRDaGFuZ2UgPSBzcC50bzsgc3BhbkVuZFN0eWxlID0gXCJcIjsgfVxuICAgICAgICAgICAgaWYgKG0uY2xhc3NOYW1lKSBzcGFuU3R5bGUgKz0gXCIgXCIgKyBtLmNsYXNzTmFtZTtcbiAgICAgICAgICAgIGlmIChtLnN0YXJ0U3R5bGUgJiYgc3AuZnJvbSA9PSBwb3MpIHNwYW5TdGFydFN0eWxlICs9IFwiIFwiICsgbS5zdGFydFN0eWxlO1xuICAgICAgICAgICAgaWYgKG0uZW5kU3R5bGUgJiYgc3AudG8gPT0gbmV4dENoYW5nZSkgc3BhbkVuZFN0eWxlICs9IFwiIFwiICsgbS5lbmRTdHlsZTtcbiAgICAgICAgICAgIGlmIChtLnRpdGxlICYmICF0aXRsZSkgdGl0bGUgPSBtLnRpdGxlO1xuICAgICAgICAgICAgaWYgKG0uY29sbGFwc2VkICYmICghY29sbGFwc2VkIHx8IGNvbXBhcmVDb2xsYXBzZWRNYXJrZXJzKGNvbGxhcHNlZC5tYXJrZXIsIG0pIDwgMCkpXG4gICAgICAgICAgICAgIGNvbGxhcHNlZCA9IHNwO1xuICAgICAgICAgIH0gZWxzZSBpZiAoc3AuZnJvbSA+IHBvcyAmJiBuZXh0Q2hhbmdlID4gc3AuZnJvbSkge1xuICAgICAgICAgICAgbmV4dENoYW5nZSA9IHNwLmZyb207XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChtLnR5cGUgPT0gXCJib29rbWFya1wiICYmIHNwLmZyb20gPT0gcG9zICYmIG0ud2lkZ2V0Tm9kZSkgZm91bmRCb29rbWFya3MucHVzaChtKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY29sbGFwc2VkICYmIChjb2xsYXBzZWQuZnJvbSB8fCAwKSA9PSBwb3MpIHtcbiAgICAgICAgICBidWlsZENvbGxhcHNlZFNwYW4oYnVpbGRlciwgKGNvbGxhcHNlZC50byA9PSBudWxsID8gbGVuICsgMSA6IGNvbGxhcHNlZC50bykgLSBwb3MsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbGxhcHNlZC5tYXJrZXIsIGNvbGxhcHNlZC5mcm9tID09IG51bGwpO1xuICAgICAgICAgIGlmIChjb2xsYXBzZWQudG8gPT0gbnVsbCkgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGlmICghY29sbGFwc2VkICYmIGZvdW5kQm9va21hcmtzLmxlbmd0aCkgZm9yICh2YXIgaiA9IDA7IGogPCBmb3VuZEJvb2ttYXJrcy5sZW5ndGg7ICsrailcbiAgICAgICAgICBidWlsZENvbGxhcHNlZFNwYW4oYnVpbGRlciwgMCwgZm91bmRCb29rbWFya3Nbal0pO1xuICAgICAgfVxuICAgICAgaWYgKHBvcyA+PSBsZW4pIGJyZWFrO1xuXG4gICAgICB2YXIgdXB0byA9IE1hdGgubWluKGxlbiwgbmV4dENoYW5nZSk7XG4gICAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgICBpZiAodGV4dCkge1xuICAgICAgICAgIHZhciBlbmQgPSBwb3MgKyB0ZXh0Lmxlbmd0aDtcbiAgICAgICAgICBpZiAoIWNvbGxhcHNlZCkge1xuICAgICAgICAgICAgdmFyIHRva2VuVGV4dCA9IGVuZCA+IHVwdG8gPyB0ZXh0LnNsaWNlKDAsIHVwdG8gLSBwb3MpIDogdGV4dDtcbiAgICAgICAgICAgIGJ1aWxkZXIuYWRkVG9rZW4oYnVpbGRlciwgdG9rZW5UZXh0LCBzdHlsZSA/IHN0eWxlICsgc3BhblN0eWxlIDogc3BhblN0eWxlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcGFuU3RhcnRTdHlsZSwgcG9zICsgdG9rZW5UZXh0Lmxlbmd0aCA9PSBuZXh0Q2hhbmdlID8gc3BhbkVuZFN0eWxlIDogXCJcIiwgdGl0bGUpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoZW5kID49IHVwdG8pIHt0ZXh0ID0gdGV4dC5zbGljZSh1cHRvIC0gcG9zKTsgcG9zID0gdXB0bzsgYnJlYWs7fVxuICAgICAgICAgIHBvcyA9IGVuZDtcbiAgICAgICAgICBzcGFuU3RhcnRTdHlsZSA9IFwiXCI7XG4gICAgICAgIH1cbiAgICAgICAgdGV4dCA9IGFsbFRleHQuc2xpY2UoYXQsIGF0ID0gc3R5bGVzW2krK10pO1xuICAgICAgICBzdHlsZSA9IGludGVycHJldFRva2VuU3R5bGUoc3R5bGVzW2krK10sIGJ1aWxkZXIuY20ub3B0aW9ucyk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gRE9DVU1FTlQgREFUQSBTVFJVQ1RVUkVcblxuICAvLyBCeSBkZWZhdWx0LCB1cGRhdGVzIHRoYXQgc3RhcnQgYW5kIGVuZCBhdCB0aGUgYmVnaW5uaW5nIG9mIGEgbGluZVxuICAvLyBhcmUgdHJlYXRlZCBzcGVjaWFsbHksIGluIG9yZGVyIHRvIG1ha2UgdGhlIGFzc29jaWF0aW9uIG9mIGxpbmVcbiAgLy8gd2lkZ2V0cyBhbmQgbWFya2VyIGVsZW1lbnRzIHdpdGggdGhlIHRleHQgYmVoYXZlIG1vcmUgaW50dWl0aXZlLlxuICBmdW5jdGlvbiBpc1dob2xlTGluZVVwZGF0ZShkb2MsIGNoYW5nZSkge1xuICAgIHJldHVybiBjaGFuZ2UuZnJvbS5jaCA9PSAwICYmIGNoYW5nZS50by5jaCA9PSAwICYmIGxzdChjaGFuZ2UudGV4dCkgPT0gXCJcIiAmJlxuICAgICAgKCFkb2MuY20gfHwgZG9jLmNtLm9wdGlvbnMud2hvbGVMaW5lVXBkYXRlQmVmb3JlKTtcbiAgfVxuXG4gIC8vIFBlcmZvcm0gYSBjaGFuZ2Ugb24gdGhlIGRvY3VtZW50IGRhdGEgc3RydWN0dXJlLlxuICBmdW5jdGlvbiB1cGRhdGVEb2MoZG9jLCBjaGFuZ2UsIG1hcmtlZFNwYW5zLCBlc3RpbWF0ZUhlaWdodCkge1xuICAgIGZ1bmN0aW9uIHNwYW5zRm9yKG4pIHtyZXR1cm4gbWFya2VkU3BhbnMgPyBtYXJrZWRTcGFuc1tuXSA6IG51bGw7fVxuICAgIGZ1bmN0aW9uIHVwZGF0ZShsaW5lLCB0ZXh0LCBzcGFucykge1xuICAgICAgdXBkYXRlTGluZShsaW5lLCB0ZXh0LCBzcGFucywgZXN0aW1hdGVIZWlnaHQpO1xuICAgICAgc2lnbmFsTGF0ZXIobGluZSwgXCJjaGFuZ2VcIiwgbGluZSwgY2hhbmdlKTtcbiAgICB9XG5cbiAgICB2YXIgZnJvbSA9IGNoYW5nZS5mcm9tLCB0byA9IGNoYW5nZS50bywgdGV4dCA9IGNoYW5nZS50ZXh0O1xuICAgIHZhciBmaXJzdExpbmUgPSBnZXRMaW5lKGRvYywgZnJvbS5saW5lKSwgbGFzdExpbmUgPSBnZXRMaW5lKGRvYywgdG8ubGluZSk7XG4gICAgdmFyIGxhc3RUZXh0ID0gbHN0KHRleHQpLCBsYXN0U3BhbnMgPSBzcGFuc0Zvcih0ZXh0Lmxlbmd0aCAtIDEpLCBubGluZXMgPSB0by5saW5lIC0gZnJvbS5saW5lO1xuXG4gICAgLy8gQWRqdXN0IHRoZSBsaW5lIHN0cnVjdHVyZVxuICAgIGlmIChpc1dob2xlTGluZVVwZGF0ZShkb2MsIGNoYW5nZSkpIHtcbiAgICAgIC8vIFRoaXMgaXMgYSB3aG9sZS1saW5lIHJlcGxhY2UuIFRyZWF0ZWQgc3BlY2lhbGx5IHRvIG1ha2VcbiAgICAgIC8vIHN1cmUgbGluZSBvYmplY3RzIG1vdmUgdGhlIHdheSB0aGV5IGFyZSBzdXBwb3NlZCB0by5cbiAgICAgIGZvciAodmFyIGkgPSAwLCBhZGRlZCA9IFtdOyBpIDwgdGV4dC5sZW5ndGggLSAxOyArK2kpXG4gICAgICAgIGFkZGVkLnB1c2gobmV3IExpbmUodGV4dFtpXSwgc3BhbnNGb3IoaSksIGVzdGltYXRlSGVpZ2h0KSk7XG4gICAgICB1cGRhdGUobGFzdExpbmUsIGxhc3RMaW5lLnRleHQsIGxhc3RTcGFucyk7XG4gICAgICBpZiAobmxpbmVzKSBkb2MucmVtb3ZlKGZyb20ubGluZSwgbmxpbmVzKTtcbiAgICAgIGlmIChhZGRlZC5sZW5ndGgpIGRvYy5pbnNlcnQoZnJvbS5saW5lLCBhZGRlZCk7XG4gICAgfSBlbHNlIGlmIChmaXJzdExpbmUgPT0gbGFzdExpbmUpIHtcbiAgICAgIGlmICh0ZXh0Lmxlbmd0aCA9PSAxKSB7XG4gICAgICAgIHVwZGF0ZShmaXJzdExpbmUsIGZpcnN0TGluZS50ZXh0LnNsaWNlKDAsIGZyb20uY2gpICsgbGFzdFRleHQgKyBmaXJzdExpbmUudGV4dC5zbGljZSh0by5jaCksIGxhc3RTcGFucyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBmb3IgKHZhciBhZGRlZCA9IFtdLCBpID0gMTsgaSA8IHRleHQubGVuZ3RoIC0gMTsgKytpKVxuICAgICAgICAgIGFkZGVkLnB1c2gobmV3IExpbmUodGV4dFtpXSwgc3BhbnNGb3IoaSksIGVzdGltYXRlSGVpZ2h0KSk7XG4gICAgICAgIGFkZGVkLnB1c2gobmV3IExpbmUobGFzdFRleHQgKyBmaXJzdExpbmUudGV4dC5zbGljZSh0by5jaCksIGxhc3RTcGFucywgZXN0aW1hdGVIZWlnaHQpKTtcbiAgICAgICAgdXBkYXRlKGZpcnN0TGluZSwgZmlyc3RMaW5lLnRleHQuc2xpY2UoMCwgZnJvbS5jaCkgKyB0ZXh0WzBdLCBzcGFuc0ZvcigwKSk7XG4gICAgICAgIGRvYy5pbnNlcnQoZnJvbS5saW5lICsgMSwgYWRkZWQpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAodGV4dC5sZW5ndGggPT0gMSkge1xuICAgICAgdXBkYXRlKGZpcnN0TGluZSwgZmlyc3RMaW5lLnRleHQuc2xpY2UoMCwgZnJvbS5jaCkgKyB0ZXh0WzBdICsgbGFzdExpbmUudGV4dC5zbGljZSh0by5jaCksIHNwYW5zRm9yKDApKTtcbiAgICAgIGRvYy5yZW1vdmUoZnJvbS5saW5lICsgMSwgbmxpbmVzKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdXBkYXRlKGZpcnN0TGluZSwgZmlyc3RMaW5lLnRleHQuc2xpY2UoMCwgZnJvbS5jaCkgKyB0ZXh0WzBdLCBzcGFuc0ZvcigwKSk7XG4gICAgICB1cGRhdGUobGFzdExpbmUsIGxhc3RUZXh0ICsgbGFzdExpbmUudGV4dC5zbGljZSh0by5jaCksIGxhc3RTcGFucyk7XG4gICAgICBmb3IgKHZhciBpID0gMSwgYWRkZWQgPSBbXTsgaSA8IHRleHQubGVuZ3RoIC0gMTsgKytpKVxuICAgICAgICBhZGRlZC5wdXNoKG5ldyBMaW5lKHRleHRbaV0sIHNwYW5zRm9yKGkpLCBlc3RpbWF0ZUhlaWdodCkpO1xuICAgICAgaWYgKG5saW5lcyA+IDEpIGRvYy5yZW1vdmUoZnJvbS5saW5lICsgMSwgbmxpbmVzIC0gMSk7XG4gICAgICBkb2MuaW5zZXJ0KGZyb20ubGluZSArIDEsIGFkZGVkKTtcbiAgICB9XG5cbiAgICBzaWduYWxMYXRlcihkb2MsIFwiY2hhbmdlXCIsIGRvYywgY2hhbmdlKTtcbiAgfVxuXG4gIC8vIFRoZSBkb2N1bWVudCBpcyByZXByZXNlbnRlZCBhcyBhIEJUcmVlIGNvbnNpc3Rpbmcgb2YgbGVhdmVzLCB3aXRoXG4gIC8vIGNodW5rIG9mIGxpbmVzIGluIHRoZW0sIGFuZCBicmFuY2hlcywgd2l0aCB1cCB0byB0ZW4gbGVhdmVzIG9yXG4gIC8vIG90aGVyIGJyYW5jaCBub2RlcyBiZWxvdyB0aGVtLiBUaGUgdG9wIG5vZGUgaXMgYWx3YXlzIGEgYnJhbmNoXG4gIC8vIG5vZGUsIGFuZCBpcyB0aGUgZG9jdW1lbnQgb2JqZWN0IGl0c2VsZiAobWVhbmluZyBpdCBoYXNcbiAgLy8gYWRkaXRpb25hbCBtZXRob2RzIGFuZCBwcm9wZXJ0aWVzKS5cbiAgLy9cbiAgLy8gQWxsIG5vZGVzIGhhdmUgcGFyZW50IGxpbmtzLiBUaGUgdHJlZSBpcyB1c2VkIGJvdGggdG8gZ28gZnJvbVxuICAvLyBsaW5lIG51bWJlcnMgdG8gbGluZSBvYmplY3RzLCBhbmQgdG8gZ28gZnJvbSBvYmplY3RzIHRvIG51bWJlcnMuXG4gIC8vIEl0IGFsc28gaW5kZXhlcyBieSBoZWlnaHQsIGFuZCBpcyB1c2VkIHRvIGNvbnZlcnQgYmV0d2VlbiBoZWlnaHRcbiAgLy8gYW5kIGxpbmUgb2JqZWN0LCBhbmQgdG8gZmluZCB0aGUgdG90YWwgaGVpZ2h0IG9mIHRoZSBkb2N1bWVudC5cbiAgLy9cbiAgLy8gU2VlIGFsc28gaHR0cDovL21hcmlqbmhhdmVyYmVrZS5ubC9ibG9nL2NvZGVtaXJyb3ItbGluZS10cmVlLmh0bWxcblxuICBmdW5jdGlvbiBMZWFmQ2h1bmsobGluZXMpIHtcbiAgICB0aGlzLmxpbmVzID0gbGluZXM7XG4gICAgdGhpcy5wYXJlbnQgPSBudWxsO1xuICAgIGZvciAodmFyIGkgPSAwLCBoZWlnaHQgPSAwOyBpIDwgbGluZXMubGVuZ3RoOyArK2kpIHtcbiAgICAgIGxpbmVzW2ldLnBhcmVudCA9IHRoaXM7XG4gICAgICBoZWlnaHQgKz0gbGluZXNbaV0uaGVpZ2h0O1xuICAgIH1cbiAgICB0aGlzLmhlaWdodCA9IGhlaWdodDtcbiAgfVxuXG4gIExlYWZDaHVuay5wcm90b3R5cGUgPSB7XG4gICAgY2h1bmtTaXplOiBmdW5jdGlvbigpIHsgcmV0dXJuIHRoaXMubGluZXMubGVuZ3RoOyB9LFxuICAgIC8vIFJlbW92ZSB0aGUgbiBsaW5lcyBhdCBvZmZzZXQgJ2F0Jy5cbiAgICByZW1vdmVJbm5lcjogZnVuY3Rpb24oYXQsIG4pIHtcbiAgICAgIGZvciAodmFyIGkgPSBhdCwgZSA9IGF0ICsgbjsgaSA8IGU7ICsraSkge1xuICAgICAgICB2YXIgbGluZSA9IHRoaXMubGluZXNbaV07XG4gICAgICAgIHRoaXMuaGVpZ2h0IC09IGxpbmUuaGVpZ2h0O1xuICAgICAgICBjbGVhblVwTGluZShsaW5lKTtcbiAgICAgICAgc2lnbmFsTGF0ZXIobGluZSwgXCJkZWxldGVcIik7XG4gICAgICB9XG4gICAgICB0aGlzLmxpbmVzLnNwbGljZShhdCwgbik7XG4gICAgfSxcbiAgICAvLyBIZWxwZXIgdXNlZCB0byBjb2xsYXBzZSBhIHNtYWxsIGJyYW5jaCBpbnRvIGEgc2luZ2xlIGxlYWYuXG4gICAgY29sbGFwc2U6IGZ1bmN0aW9uKGxpbmVzKSB7XG4gICAgICBsaW5lcy5wdXNoLmFwcGx5KGxpbmVzLCB0aGlzLmxpbmVzKTtcbiAgICB9LFxuICAgIC8vIEluc2VydCB0aGUgZ2l2ZW4gYXJyYXkgb2YgbGluZXMgYXQgb2Zmc2V0ICdhdCcsIGNvdW50IHRoZW0gYXNcbiAgICAvLyBoYXZpbmcgdGhlIGdpdmVuIGhlaWdodC5cbiAgICBpbnNlcnRJbm5lcjogZnVuY3Rpb24oYXQsIGxpbmVzLCBoZWlnaHQpIHtcbiAgICAgIHRoaXMuaGVpZ2h0ICs9IGhlaWdodDtcbiAgICAgIHRoaXMubGluZXMgPSB0aGlzLmxpbmVzLnNsaWNlKDAsIGF0KS5jb25jYXQobGluZXMpLmNvbmNhdCh0aGlzLmxpbmVzLnNsaWNlKGF0KSk7XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxpbmVzLmxlbmd0aDsgKytpKSBsaW5lc1tpXS5wYXJlbnQgPSB0aGlzO1xuICAgIH0sXG4gICAgLy8gVXNlZCB0byBpdGVyYXRlIG92ZXIgYSBwYXJ0IG9mIHRoZSB0cmVlLlxuICAgIGl0ZXJOOiBmdW5jdGlvbihhdCwgbiwgb3ApIHtcbiAgICAgIGZvciAodmFyIGUgPSBhdCArIG47IGF0IDwgZTsgKythdClcbiAgICAgICAgaWYgKG9wKHRoaXMubGluZXNbYXRdKSkgcmV0dXJuIHRydWU7XG4gICAgfVxuICB9O1xuXG4gIGZ1bmN0aW9uIEJyYW5jaENodW5rKGNoaWxkcmVuKSB7XG4gICAgdGhpcy5jaGlsZHJlbiA9IGNoaWxkcmVuO1xuICAgIHZhciBzaXplID0gMCwgaGVpZ2h0ID0gMDtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGNoaWxkcmVuLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YXIgY2ggPSBjaGlsZHJlbltpXTtcbiAgICAgIHNpemUgKz0gY2guY2h1bmtTaXplKCk7IGhlaWdodCArPSBjaC5oZWlnaHQ7XG4gICAgICBjaC5wYXJlbnQgPSB0aGlzO1xuICAgIH1cbiAgICB0aGlzLnNpemUgPSBzaXplO1xuICAgIHRoaXMuaGVpZ2h0ID0gaGVpZ2h0O1xuICAgIHRoaXMucGFyZW50ID0gbnVsbDtcbiAgfVxuXG4gIEJyYW5jaENodW5rLnByb3RvdHlwZSA9IHtcbiAgICBjaHVua1NpemU6IGZ1bmN0aW9uKCkgeyByZXR1cm4gdGhpcy5zaXplOyB9LFxuICAgIHJlbW92ZUlubmVyOiBmdW5jdGlvbihhdCwgbikge1xuICAgICAgdGhpcy5zaXplIC09IG47XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHRoaXMuY2hpbGRyZW4ubGVuZ3RoOyArK2kpIHtcbiAgICAgICAgdmFyIGNoaWxkID0gdGhpcy5jaGlsZHJlbltpXSwgc3ogPSBjaGlsZC5jaHVua1NpemUoKTtcbiAgICAgICAgaWYgKGF0IDwgc3opIHtcbiAgICAgICAgICB2YXIgcm0gPSBNYXRoLm1pbihuLCBzeiAtIGF0KSwgb2xkSGVpZ2h0ID0gY2hpbGQuaGVpZ2h0O1xuICAgICAgICAgIGNoaWxkLnJlbW92ZUlubmVyKGF0LCBybSk7XG4gICAgICAgICAgdGhpcy5oZWlnaHQgLT0gb2xkSGVpZ2h0IC0gY2hpbGQuaGVpZ2h0O1xuICAgICAgICAgIGlmIChzeiA9PSBybSkgeyB0aGlzLmNoaWxkcmVuLnNwbGljZShpLS0sIDEpOyBjaGlsZC5wYXJlbnQgPSBudWxsOyB9XG4gICAgICAgICAgaWYgKChuIC09IHJtKSA9PSAwKSBicmVhaztcbiAgICAgICAgICBhdCA9IDA7XG4gICAgICAgIH0gZWxzZSBhdCAtPSBzejtcbiAgICAgIH1cbiAgICAgIC8vIElmIHRoZSByZXN1bHQgaXMgc21hbGxlciB0aGFuIDI1IGxpbmVzLCBlbnN1cmUgdGhhdCBpdCBpcyBhXG4gICAgICAvLyBzaW5nbGUgbGVhZiBub2RlLlxuICAgICAgaWYgKHRoaXMuc2l6ZSAtIG4gPCAyNSAmJlxuICAgICAgICAgICh0aGlzLmNoaWxkcmVuLmxlbmd0aCA+IDEgfHwgISh0aGlzLmNoaWxkcmVuWzBdIGluc3RhbmNlb2YgTGVhZkNodW5rKSkpIHtcbiAgICAgICAgdmFyIGxpbmVzID0gW107XG4gICAgICAgIHRoaXMuY29sbGFwc2UobGluZXMpO1xuICAgICAgICB0aGlzLmNoaWxkcmVuID0gW25ldyBMZWFmQ2h1bmsobGluZXMpXTtcbiAgICAgICAgdGhpcy5jaGlsZHJlblswXS5wYXJlbnQgPSB0aGlzO1xuICAgICAgfVxuICAgIH0sXG4gICAgY29sbGFwc2U6IGZ1bmN0aW9uKGxpbmVzKSB7XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHRoaXMuY2hpbGRyZW4ubGVuZ3RoOyArK2kpIHRoaXMuY2hpbGRyZW5baV0uY29sbGFwc2UobGluZXMpO1xuICAgIH0sXG4gICAgaW5zZXJ0SW5uZXI6IGZ1bmN0aW9uKGF0LCBsaW5lcywgaGVpZ2h0KSB7XG4gICAgICB0aGlzLnNpemUgKz0gbGluZXMubGVuZ3RoO1xuICAgICAgdGhpcy5oZWlnaHQgKz0gaGVpZ2h0O1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLmNoaWxkcmVuLmxlbmd0aDsgKytpKSB7XG4gICAgICAgIHZhciBjaGlsZCA9IHRoaXMuY2hpbGRyZW5baV0sIHN6ID0gY2hpbGQuY2h1bmtTaXplKCk7XG4gICAgICAgIGlmIChhdCA8PSBzeikge1xuICAgICAgICAgIGNoaWxkLmluc2VydElubmVyKGF0LCBsaW5lcywgaGVpZ2h0KTtcbiAgICAgICAgICBpZiAoY2hpbGQubGluZXMgJiYgY2hpbGQubGluZXMubGVuZ3RoID4gNTApIHtcbiAgICAgICAgICAgIHdoaWxlIChjaGlsZC5saW5lcy5sZW5ndGggPiA1MCkge1xuICAgICAgICAgICAgICB2YXIgc3BpbGxlZCA9IGNoaWxkLmxpbmVzLnNwbGljZShjaGlsZC5saW5lcy5sZW5ndGggLSAyNSwgMjUpO1xuICAgICAgICAgICAgICB2YXIgbmV3bGVhZiA9IG5ldyBMZWFmQ2h1bmsoc3BpbGxlZCk7XG4gICAgICAgICAgICAgIGNoaWxkLmhlaWdodCAtPSBuZXdsZWFmLmhlaWdodDtcbiAgICAgICAgICAgICAgdGhpcy5jaGlsZHJlbi5zcGxpY2UoaSArIDEsIDAsIG5ld2xlYWYpO1xuICAgICAgICAgICAgICBuZXdsZWFmLnBhcmVudCA9IHRoaXM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0aGlzLm1heWJlU3BpbGwoKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgYXQgLT0gc3o7XG4gICAgICB9XG4gICAgfSxcbiAgICAvLyBXaGVuIGEgbm9kZSBoYXMgZ3Jvd24sIGNoZWNrIHdoZXRoZXIgaXQgc2hvdWxkIGJlIHNwbGl0LlxuICAgIG1heWJlU3BpbGw6IGZ1bmN0aW9uKCkge1xuICAgICAgaWYgKHRoaXMuY2hpbGRyZW4ubGVuZ3RoIDw9IDEwKSByZXR1cm47XG4gICAgICB2YXIgbWUgPSB0aGlzO1xuICAgICAgZG8ge1xuICAgICAgICB2YXIgc3BpbGxlZCA9IG1lLmNoaWxkcmVuLnNwbGljZShtZS5jaGlsZHJlbi5sZW5ndGggLSA1LCA1KTtcbiAgICAgICAgdmFyIHNpYmxpbmcgPSBuZXcgQnJhbmNoQ2h1bmsoc3BpbGxlZCk7XG4gICAgICAgIGlmICghbWUucGFyZW50KSB7IC8vIEJlY29tZSB0aGUgcGFyZW50IG5vZGVcbiAgICAgICAgICB2YXIgY29weSA9IG5ldyBCcmFuY2hDaHVuayhtZS5jaGlsZHJlbik7XG4gICAgICAgICAgY29weS5wYXJlbnQgPSBtZTtcbiAgICAgICAgICBtZS5jaGlsZHJlbiA9IFtjb3B5LCBzaWJsaW5nXTtcbiAgICAgICAgICBtZSA9IGNvcHk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgbWUuc2l6ZSAtPSBzaWJsaW5nLnNpemU7XG4gICAgICAgICAgbWUuaGVpZ2h0IC09IHNpYmxpbmcuaGVpZ2h0O1xuICAgICAgICAgIHZhciBteUluZGV4ID0gaW5kZXhPZihtZS5wYXJlbnQuY2hpbGRyZW4sIG1lKTtcbiAgICAgICAgICBtZS5wYXJlbnQuY2hpbGRyZW4uc3BsaWNlKG15SW5kZXggKyAxLCAwLCBzaWJsaW5nKTtcbiAgICAgICAgfVxuICAgICAgICBzaWJsaW5nLnBhcmVudCA9IG1lLnBhcmVudDtcbiAgICAgIH0gd2hpbGUgKG1lLmNoaWxkcmVuLmxlbmd0aCA+IDEwKTtcbiAgICAgIG1lLnBhcmVudC5tYXliZVNwaWxsKCk7XG4gICAgfSxcbiAgICBpdGVyTjogZnVuY3Rpb24oYXQsIG4sIG9wKSB7XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHRoaXMuY2hpbGRyZW4ubGVuZ3RoOyArK2kpIHtcbiAgICAgICAgdmFyIGNoaWxkID0gdGhpcy5jaGlsZHJlbltpXSwgc3ogPSBjaGlsZC5jaHVua1NpemUoKTtcbiAgICAgICAgaWYgKGF0IDwgc3opIHtcbiAgICAgICAgICB2YXIgdXNlZCA9IE1hdGgubWluKG4sIHN6IC0gYXQpO1xuICAgICAgICAgIGlmIChjaGlsZC5pdGVyTihhdCwgdXNlZCwgb3ApKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICBpZiAoKG4gLT0gdXNlZCkgPT0gMCkgYnJlYWs7XG4gICAgICAgICAgYXQgPSAwO1xuICAgICAgICB9IGVsc2UgYXQgLT0gc3o7XG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIHZhciBuZXh0RG9jSWQgPSAwO1xuICB2YXIgRG9jID0gQ29kZU1pcnJvci5Eb2MgPSBmdW5jdGlvbih0ZXh0LCBtb2RlLCBmaXJzdExpbmUpIHtcbiAgICBpZiAoISh0aGlzIGluc3RhbmNlb2YgRG9jKSkgcmV0dXJuIG5ldyBEb2ModGV4dCwgbW9kZSwgZmlyc3RMaW5lKTtcbiAgICBpZiAoZmlyc3RMaW5lID09IG51bGwpIGZpcnN0TGluZSA9IDA7XG5cbiAgICBCcmFuY2hDaHVuay5jYWxsKHRoaXMsIFtuZXcgTGVhZkNodW5rKFtuZXcgTGluZShcIlwiLCBudWxsKV0pXSk7XG4gICAgdGhpcy5maXJzdCA9IGZpcnN0TGluZTtcbiAgICB0aGlzLnNjcm9sbFRvcCA9IHRoaXMuc2Nyb2xsTGVmdCA9IDA7XG4gICAgdGhpcy5jYW50RWRpdCA9IGZhbHNlO1xuICAgIHRoaXMuY2xlYW5HZW5lcmF0aW9uID0gMTtcbiAgICB0aGlzLmZyb250aWVyID0gZmlyc3RMaW5lO1xuICAgIHZhciBzdGFydCA9IFBvcyhmaXJzdExpbmUsIDApO1xuICAgIHRoaXMuc2VsID0gc2ltcGxlU2VsZWN0aW9uKHN0YXJ0KTtcbiAgICB0aGlzLmhpc3RvcnkgPSBuZXcgSGlzdG9yeShudWxsKTtcbiAgICB0aGlzLmlkID0gKytuZXh0RG9jSWQ7XG4gICAgdGhpcy5tb2RlT3B0aW9uID0gbW9kZTtcblxuICAgIGlmICh0eXBlb2YgdGV4dCA9PSBcInN0cmluZ1wiKSB0ZXh0ID0gc3BsaXRMaW5lcyh0ZXh0KTtcbiAgICB1cGRhdGVEb2ModGhpcywge2Zyb206IHN0YXJ0LCB0bzogc3RhcnQsIHRleHQ6IHRleHR9KTtcbiAgICBzZXRTZWxlY3Rpb24odGhpcywgc2ltcGxlU2VsZWN0aW9uKHN0YXJ0KSwgc2VsX2RvbnRTY3JvbGwpO1xuICB9O1xuXG4gIERvYy5wcm90b3R5cGUgPSBjcmVhdGVPYmooQnJhbmNoQ2h1bmsucHJvdG90eXBlLCB7XG4gICAgY29uc3RydWN0b3I6IERvYyxcbiAgICAvLyBJdGVyYXRlIG92ZXIgdGhlIGRvY3VtZW50LiBTdXBwb3J0cyB0d28gZm9ybXMgLS0gd2l0aCBvbmx5IG9uZVxuICAgIC8vIGFyZ3VtZW50LCBpdCBjYWxscyB0aGF0IGZvciBlYWNoIGxpbmUgaW4gdGhlIGRvY3VtZW50LiBXaXRoXG4gICAgLy8gdGhyZWUsIGl0IGl0ZXJhdGVzIG92ZXIgdGhlIHJhbmdlIGdpdmVuIGJ5IHRoZSBmaXJzdCB0d28gKHdpdGhcbiAgICAvLyB0aGUgc2Vjb25kIGJlaW5nIG5vbi1pbmNsdXNpdmUpLlxuICAgIGl0ZXI6IGZ1bmN0aW9uKGZyb20sIHRvLCBvcCkge1xuICAgICAgaWYgKG9wKSB0aGlzLml0ZXJOKGZyb20gLSB0aGlzLmZpcnN0LCB0byAtIGZyb20sIG9wKTtcbiAgICAgIGVsc2UgdGhpcy5pdGVyTih0aGlzLmZpcnN0LCB0aGlzLmZpcnN0ICsgdGhpcy5zaXplLCBmcm9tKTtcbiAgICB9LFxuXG4gICAgLy8gTm9uLXB1YmxpYyBpbnRlcmZhY2UgZm9yIGFkZGluZyBhbmQgcmVtb3ZpbmcgbGluZXMuXG4gICAgaW5zZXJ0OiBmdW5jdGlvbihhdCwgbGluZXMpIHtcbiAgICAgIHZhciBoZWlnaHQgPSAwO1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsaW5lcy5sZW5ndGg7ICsraSkgaGVpZ2h0ICs9IGxpbmVzW2ldLmhlaWdodDtcbiAgICAgIHRoaXMuaW5zZXJ0SW5uZXIoYXQgLSB0aGlzLmZpcnN0LCBsaW5lcywgaGVpZ2h0KTtcbiAgICB9LFxuICAgIHJlbW92ZTogZnVuY3Rpb24oYXQsIG4pIHsgdGhpcy5yZW1vdmVJbm5lcihhdCAtIHRoaXMuZmlyc3QsIG4pOyB9LFxuXG4gICAgLy8gRnJvbSBoZXJlLCB0aGUgbWV0aG9kcyBhcmUgcGFydCBvZiB0aGUgcHVibGljIGludGVyZmFjZS4gTW9zdFxuICAgIC8vIGFyZSBhbHNvIGF2YWlsYWJsZSBmcm9tIENvZGVNaXJyb3IgKGVkaXRvcikgaW5zdGFuY2VzLlxuXG4gICAgZ2V0VmFsdWU6IGZ1bmN0aW9uKGxpbmVTZXApIHtcbiAgICAgIHZhciBsaW5lcyA9IGdldExpbmVzKHRoaXMsIHRoaXMuZmlyc3QsIHRoaXMuZmlyc3QgKyB0aGlzLnNpemUpO1xuICAgICAgaWYgKGxpbmVTZXAgPT09IGZhbHNlKSByZXR1cm4gbGluZXM7XG4gICAgICByZXR1cm4gbGluZXMuam9pbihsaW5lU2VwIHx8IFwiXFxuXCIpO1xuICAgIH0sXG4gICAgc2V0VmFsdWU6IGRvY01ldGhvZE9wKGZ1bmN0aW9uKGNvZGUpIHtcbiAgICAgIHZhciB0b3AgPSBQb3ModGhpcy5maXJzdCwgMCksIGxhc3QgPSB0aGlzLmZpcnN0ICsgdGhpcy5zaXplIC0gMTtcbiAgICAgIG1ha2VDaGFuZ2UodGhpcywge2Zyb206IHRvcCwgdG86IFBvcyhsYXN0LCBnZXRMaW5lKHRoaXMsIGxhc3QpLnRleHQubGVuZ3RoKSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHRleHQ6IHNwbGl0TGluZXMoY29kZSksIG9yaWdpbjogXCJzZXRWYWx1ZVwifSwgdHJ1ZSk7XG4gICAgICBzZXRTZWxlY3Rpb24odGhpcywgc2ltcGxlU2VsZWN0aW9uKHRvcCkpO1xuICAgIH0pLFxuICAgIHJlcGxhY2VSYW5nZTogZnVuY3Rpb24oY29kZSwgZnJvbSwgdG8sIG9yaWdpbikge1xuICAgICAgZnJvbSA9IGNsaXBQb3ModGhpcywgZnJvbSk7XG4gICAgICB0byA9IHRvID8gY2xpcFBvcyh0aGlzLCB0bykgOiBmcm9tO1xuICAgICAgcmVwbGFjZVJhbmdlKHRoaXMsIGNvZGUsIGZyb20sIHRvLCBvcmlnaW4pO1xuICAgIH0sXG4gICAgZ2V0UmFuZ2U6IGZ1bmN0aW9uKGZyb20sIHRvLCBsaW5lU2VwKSB7XG4gICAgICB2YXIgbGluZXMgPSBnZXRCZXR3ZWVuKHRoaXMsIGNsaXBQb3ModGhpcywgZnJvbSksIGNsaXBQb3ModGhpcywgdG8pKTtcbiAgICAgIGlmIChsaW5lU2VwID09PSBmYWxzZSkgcmV0dXJuIGxpbmVzO1xuICAgICAgcmV0dXJuIGxpbmVzLmpvaW4obGluZVNlcCB8fCBcIlxcblwiKTtcbiAgICB9LFxuXG4gICAgZ2V0TGluZTogZnVuY3Rpb24obGluZSkge3ZhciBsID0gdGhpcy5nZXRMaW5lSGFuZGxlKGxpbmUpOyByZXR1cm4gbCAmJiBsLnRleHQ7fSxcblxuICAgIGdldExpbmVIYW5kbGU6IGZ1bmN0aW9uKGxpbmUpIHtpZiAoaXNMaW5lKHRoaXMsIGxpbmUpKSByZXR1cm4gZ2V0TGluZSh0aGlzLCBsaW5lKTt9LFxuICAgIGdldExpbmVOdW1iZXI6IGZ1bmN0aW9uKGxpbmUpIHtyZXR1cm4gbGluZU5vKGxpbmUpO30sXG5cbiAgICBnZXRMaW5lSGFuZGxlVmlzdWFsU3RhcnQ6IGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgIGlmICh0eXBlb2YgbGluZSA9PSBcIm51bWJlclwiKSBsaW5lID0gZ2V0TGluZSh0aGlzLCBsaW5lKTtcbiAgICAgIHJldHVybiB2aXN1YWxMaW5lKGxpbmUpO1xuICAgIH0sXG5cbiAgICBsaW5lQ291bnQ6IGZ1bmN0aW9uKCkge3JldHVybiB0aGlzLnNpemU7fSxcbiAgICBmaXJzdExpbmU6IGZ1bmN0aW9uKCkge3JldHVybiB0aGlzLmZpcnN0O30sXG4gICAgbGFzdExpbmU6IGZ1bmN0aW9uKCkge3JldHVybiB0aGlzLmZpcnN0ICsgdGhpcy5zaXplIC0gMTt9LFxuXG4gICAgY2xpcFBvczogZnVuY3Rpb24ocG9zKSB7cmV0dXJuIGNsaXBQb3ModGhpcywgcG9zKTt9LFxuXG4gICAgZ2V0Q3Vyc29yOiBmdW5jdGlvbihzdGFydCkge1xuICAgICAgdmFyIHJhbmdlID0gdGhpcy5zZWwucHJpbWFyeSgpLCBwb3M7XG4gICAgICBpZiAoc3RhcnQgPT0gbnVsbCB8fCBzdGFydCA9PSBcImhlYWRcIikgcG9zID0gcmFuZ2UuaGVhZDtcbiAgICAgIGVsc2UgaWYgKHN0YXJ0ID09IFwiYW5jaG9yXCIpIHBvcyA9IHJhbmdlLmFuY2hvcjtcbiAgICAgIGVsc2UgaWYgKHN0YXJ0ID09IFwiZW5kXCIgfHwgc3RhcnQgPT0gXCJ0b1wiIHx8IHN0YXJ0ID09PSBmYWxzZSkgcG9zID0gcmFuZ2UudG8oKTtcbiAgICAgIGVsc2UgcG9zID0gcmFuZ2UuZnJvbSgpO1xuICAgICAgcmV0dXJuIHBvcztcbiAgICB9LFxuICAgIGxpc3RTZWxlY3Rpb25zOiBmdW5jdGlvbigpIHsgcmV0dXJuIHRoaXMuc2VsLnJhbmdlczsgfSxcbiAgICBzb21ldGhpbmdTZWxlY3RlZDogZnVuY3Rpb24oKSB7cmV0dXJuIHRoaXMuc2VsLnNvbWV0aGluZ1NlbGVjdGVkKCk7fSxcblxuICAgIHNldEN1cnNvcjogZG9jTWV0aG9kT3AoZnVuY3Rpb24obGluZSwgY2gsIG9wdGlvbnMpIHtcbiAgICAgIHNldFNpbXBsZVNlbGVjdGlvbih0aGlzLCBjbGlwUG9zKHRoaXMsIHR5cGVvZiBsaW5lID09IFwibnVtYmVyXCIgPyBQb3MobGluZSwgY2ggfHwgMCkgOiBsaW5lKSwgbnVsbCwgb3B0aW9ucyk7XG4gICAgfSksXG4gICAgc2V0U2VsZWN0aW9uOiBkb2NNZXRob2RPcChmdW5jdGlvbihhbmNob3IsIGhlYWQsIG9wdGlvbnMpIHtcbiAgICAgIHNldFNpbXBsZVNlbGVjdGlvbih0aGlzLCBjbGlwUG9zKHRoaXMsIGFuY2hvciksIGNsaXBQb3ModGhpcywgaGVhZCB8fCBhbmNob3IpLCBvcHRpb25zKTtcbiAgICB9KSxcbiAgICBleHRlbmRTZWxlY3Rpb246IGRvY01ldGhvZE9wKGZ1bmN0aW9uKGhlYWQsIG90aGVyLCBvcHRpb25zKSB7XG4gICAgICBleHRlbmRTZWxlY3Rpb24odGhpcywgY2xpcFBvcyh0aGlzLCBoZWFkKSwgb3RoZXIgJiYgY2xpcFBvcyh0aGlzLCBvdGhlciksIG9wdGlvbnMpO1xuICAgIH0pLFxuICAgIGV4dGVuZFNlbGVjdGlvbnM6IGRvY01ldGhvZE9wKGZ1bmN0aW9uKGhlYWRzLCBvcHRpb25zKSB7XG4gICAgICBleHRlbmRTZWxlY3Rpb25zKHRoaXMsIGNsaXBQb3NBcnJheSh0aGlzLCBoZWFkcywgb3B0aW9ucykpO1xuICAgIH0pLFxuICAgIGV4dGVuZFNlbGVjdGlvbnNCeTogZG9jTWV0aG9kT3AoZnVuY3Rpb24oZiwgb3B0aW9ucykge1xuICAgICAgZXh0ZW5kU2VsZWN0aW9ucyh0aGlzLCBtYXAodGhpcy5zZWwucmFuZ2VzLCBmKSwgb3B0aW9ucyk7XG4gICAgfSksXG4gICAgc2V0U2VsZWN0aW9uczogZG9jTWV0aG9kT3AoZnVuY3Rpb24ocmFuZ2VzLCBwcmltYXJ5LCBvcHRpb25zKSB7XG4gICAgICBpZiAoIXJhbmdlcy5sZW5ndGgpIHJldHVybjtcbiAgICAgIGZvciAodmFyIGkgPSAwLCBvdXQgPSBbXTsgaSA8IHJhbmdlcy5sZW5ndGg7IGkrKylcbiAgICAgICAgb3V0W2ldID0gbmV3IFJhbmdlKGNsaXBQb3ModGhpcywgcmFuZ2VzW2ldLmFuY2hvciksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICBjbGlwUG9zKHRoaXMsIHJhbmdlc1tpXS5oZWFkKSk7XG4gICAgICBpZiAocHJpbWFyeSA9PSBudWxsKSBwcmltYXJ5ID0gTWF0aC5taW4ocmFuZ2VzLmxlbmd0aCAtIDEsIHRoaXMuc2VsLnByaW1JbmRleCk7XG4gICAgICBzZXRTZWxlY3Rpb24odGhpcywgbm9ybWFsaXplU2VsZWN0aW9uKG91dCwgcHJpbWFyeSksIG9wdGlvbnMpO1xuICAgIH0pLFxuICAgIGFkZFNlbGVjdGlvbjogZG9jTWV0aG9kT3AoZnVuY3Rpb24oYW5jaG9yLCBoZWFkLCBvcHRpb25zKSB7XG4gICAgICB2YXIgcmFuZ2VzID0gdGhpcy5zZWwucmFuZ2VzLnNsaWNlKDApO1xuICAgICAgcmFuZ2VzLnB1c2gobmV3IFJhbmdlKGNsaXBQb3ModGhpcywgYW5jaG9yKSwgY2xpcFBvcyh0aGlzLCBoZWFkIHx8IGFuY2hvcikpKTtcbiAgICAgIHNldFNlbGVjdGlvbih0aGlzLCBub3JtYWxpemVTZWxlY3Rpb24ocmFuZ2VzLCByYW5nZXMubGVuZ3RoIC0gMSksIG9wdGlvbnMpO1xuICAgIH0pLFxuXG4gICAgZ2V0U2VsZWN0aW9uOiBmdW5jdGlvbihsaW5lU2VwKSB7XG4gICAgICB2YXIgcmFuZ2VzID0gdGhpcy5zZWwucmFuZ2VzLCBsaW5lcztcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgcmFuZ2VzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIHZhciBzZWwgPSBnZXRCZXR3ZWVuKHRoaXMsIHJhbmdlc1tpXS5mcm9tKCksIHJhbmdlc1tpXS50bygpKTtcbiAgICAgICAgbGluZXMgPSBsaW5lcyA/IGxpbmVzLmNvbmNhdChzZWwpIDogc2VsO1xuICAgICAgfVxuICAgICAgaWYgKGxpbmVTZXAgPT09IGZhbHNlKSByZXR1cm4gbGluZXM7XG4gICAgICBlbHNlIHJldHVybiBsaW5lcy5qb2luKGxpbmVTZXAgfHwgXCJcXG5cIik7XG4gICAgfSxcbiAgICBnZXRTZWxlY3Rpb25zOiBmdW5jdGlvbihsaW5lU2VwKSB7XG4gICAgICB2YXIgcGFydHMgPSBbXSwgcmFuZ2VzID0gdGhpcy5zZWwucmFuZ2VzO1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCByYW5nZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgdmFyIHNlbCA9IGdldEJldHdlZW4odGhpcywgcmFuZ2VzW2ldLmZyb20oKSwgcmFuZ2VzW2ldLnRvKCkpO1xuICAgICAgICBpZiAobGluZVNlcCAhPT0gZmFsc2UpIHNlbCA9IHNlbC5qb2luKGxpbmVTZXAgfHwgXCJcXG5cIik7XG4gICAgICAgIHBhcnRzW2ldID0gc2VsO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHBhcnRzO1xuICAgIH0sXG4gICAgcmVwbGFjZVNlbGVjdGlvbjogZnVuY3Rpb24oY29kZSwgY29sbGFwc2UsIG9yaWdpbikge1xuICAgICAgdmFyIGR1cCA9IFtdO1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLnNlbC5yYW5nZXMubGVuZ3RoOyBpKyspXG4gICAgICAgIGR1cFtpXSA9IGNvZGU7XG4gICAgICB0aGlzLnJlcGxhY2VTZWxlY3Rpb25zKGR1cCwgY29sbGFwc2UsIG9yaWdpbiB8fCBcIitpbnB1dFwiKTtcbiAgICB9LFxuICAgIHJlcGxhY2VTZWxlY3Rpb25zOiBkb2NNZXRob2RPcChmdW5jdGlvbihjb2RlLCBjb2xsYXBzZSwgb3JpZ2luKSB7XG4gICAgICB2YXIgY2hhbmdlcyA9IFtdLCBzZWwgPSB0aGlzLnNlbDtcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgc2VsLnJhbmdlcy5sZW5ndGg7IGkrKykge1xuICAgICAgICB2YXIgcmFuZ2UgPSBzZWwucmFuZ2VzW2ldO1xuICAgICAgICBjaGFuZ2VzW2ldID0ge2Zyb206IHJhbmdlLmZyb20oKSwgdG86IHJhbmdlLnRvKCksIHRleHQ6IHNwbGl0TGluZXMoY29kZVtpXSksIG9yaWdpbjogb3JpZ2lufTtcbiAgICAgIH1cbiAgICAgIHZhciBuZXdTZWwgPSBjb2xsYXBzZSAmJiBjb2xsYXBzZSAhPSBcImVuZFwiICYmIGNvbXB1dGVSZXBsYWNlZFNlbCh0aGlzLCBjaGFuZ2VzLCBjb2xsYXBzZSk7XG4gICAgICBmb3IgKHZhciBpID0gY2hhbmdlcy5sZW5ndGggLSAxOyBpID49IDA7IGktLSlcbiAgICAgICAgbWFrZUNoYW5nZSh0aGlzLCBjaGFuZ2VzW2ldKTtcbiAgICAgIGlmIChuZXdTZWwpIHNldFNlbGVjdGlvblJlcGxhY2VIaXN0b3J5KHRoaXMsIG5ld1NlbCk7XG4gICAgICBlbHNlIGlmICh0aGlzLmNtKSBlbnN1cmVDdXJzb3JWaXNpYmxlKHRoaXMuY20pO1xuICAgIH0pLFxuICAgIHVuZG86IGRvY01ldGhvZE9wKGZ1bmN0aW9uKCkge21ha2VDaGFuZ2VGcm9tSGlzdG9yeSh0aGlzLCBcInVuZG9cIik7fSksXG4gICAgcmVkbzogZG9jTWV0aG9kT3AoZnVuY3Rpb24oKSB7bWFrZUNoYW5nZUZyb21IaXN0b3J5KHRoaXMsIFwicmVkb1wiKTt9KSxcbiAgICB1bmRvU2VsZWN0aW9uOiBkb2NNZXRob2RPcChmdW5jdGlvbigpIHttYWtlQ2hhbmdlRnJvbUhpc3RvcnkodGhpcywgXCJ1bmRvXCIsIHRydWUpO30pLFxuICAgIHJlZG9TZWxlY3Rpb246IGRvY01ldGhvZE9wKGZ1bmN0aW9uKCkge21ha2VDaGFuZ2VGcm9tSGlzdG9yeSh0aGlzLCBcInJlZG9cIiwgdHJ1ZSk7fSksXG5cbiAgICBzZXRFeHRlbmRpbmc6IGZ1bmN0aW9uKHZhbCkge3RoaXMuZXh0ZW5kID0gdmFsO30sXG4gICAgZ2V0RXh0ZW5kaW5nOiBmdW5jdGlvbigpIHtyZXR1cm4gdGhpcy5leHRlbmQ7fSxcblxuICAgIGhpc3RvcnlTaXplOiBmdW5jdGlvbigpIHtcbiAgICAgIHZhciBoaXN0ID0gdGhpcy5oaXN0b3J5LCBkb25lID0gMCwgdW5kb25lID0gMDtcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgaGlzdC5kb25lLmxlbmd0aDsgaSsrKSBpZiAoIWhpc3QuZG9uZVtpXS5yYW5nZXMpICsrZG9uZTtcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgaGlzdC51bmRvbmUubGVuZ3RoOyBpKyspIGlmICghaGlzdC51bmRvbmVbaV0ucmFuZ2VzKSArK3VuZG9uZTtcbiAgICAgIHJldHVybiB7dW5kbzogZG9uZSwgcmVkbzogdW5kb25lfTtcbiAgICB9LFxuICAgIGNsZWFySGlzdG9yeTogZnVuY3Rpb24oKSB7dGhpcy5oaXN0b3J5ID0gbmV3IEhpc3RvcnkodGhpcy5oaXN0b3J5Lm1heEdlbmVyYXRpb24pO30sXG5cbiAgICBtYXJrQ2xlYW46IGZ1bmN0aW9uKCkge1xuICAgICAgdGhpcy5jbGVhbkdlbmVyYXRpb24gPSB0aGlzLmNoYW5nZUdlbmVyYXRpb24odHJ1ZSk7XG4gICAgfSxcbiAgICBjaGFuZ2VHZW5lcmF0aW9uOiBmdW5jdGlvbihmb3JjZVNwbGl0KSB7XG4gICAgICBpZiAoZm9yY2VTcGxpdClcbiAgICAgICAgdGhpcy5oaXN0b3J5Lmxhc3RPcCA9IHRoaXMuaGlzdG9yeS5sYXN0T3JpZ2luID0gbnVsbDtcbiAgICAgIHJldHVybiB0aGlzLmhpc3RvcnkuZ2VuZXJhdGlvbjtcbiAgICB9LFxuICAgIGlzQ2xlYW46IGZ1bmN0aW9uIChnZW4pIHtcbiAgICAgIHJldHVybiB0aGlzLmhpc3RvcnkuZ2VuZXJhdGlvbiA9PSAoZ2VuIHx8IHRoaXMuY2xlYW5HZW5lcmF0aW9uKTtcbiAgICB9LFxuXG4gICAgZ2V0SGlzdG9yeTogZnVuY3Rpb24oKSB7XG4gICAgICByZXR1cm4ge2RvbmU6IGNvcHlIaXN0b3J5QXJyYXkodGhpcy5oaXN0b3J5LmRvbmUpLFxuICAgICAgICAgICAgICB1bmRvbmU6IGNvcHlIaXN0b3J5QXJyYXkodGhpcy5oaXN0b3J5LnVuZG9uZSl9O1xuICAgIH0sXG4gICAgc2V0SGlzdG9yeTogZnVuY3Rpb24oaGlzdERhdGEpIHtcbiAgICAgIHZhciBoaXN0ID0gdGhpcy5oaXN0b3J5ID0gbmV3IEhpc3RvcnkodGhpcy5oaXN0b3J5Lm1heEdlbmVyYXRpb24pO1xuICAgICAgaGlzdC5kb25lID0gY29weUhpc3RvcnlBcnJheShoaXN0RGF0YS5kb25lLnNsaWNlKDApLCBudWxsLCB0cnVlKTtcbiAgICAgIGhpc3QudW5kb25lID0gY29weUhpc3RvcnlBcnJheShoaXN0RGF0YS51bmRvbmUuc2xpY2UoMCksIG51bGwsIHRydWUpO1xuICAgIH0sXG5cbiAgICBhZGRMaW5lQ2xhc3M6IGRvY01ldGhvZE9wKGZ1bmN0aW9uKGhhbmRsZSwgd2hlcmUsIGNscykge1xuICAgICAgcmV0dXJuIGNoYW5nZUxpbmUodGhpcywgaGFuZGxlLCBcImNsYXNzXCIsIGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgICAgdmFyIHByb3AgPSB3aGVyZSA9PSBcInRleHRcIiA/IFwidGV4dENsYXNzXCIgOiB3aGVyZSA9PSBcImJhY2tncm91bmRcIiA/IFwiYmdDbGFzc1wiIDogXCJ3cmFwQ2xhc3NcIjtcbiAgICAgICAgaWYgKCFsaW5lW3Byb3BdKSBsaW5lW3Byb3BdID0gY2xzO1xuICAgICAgICBlbHNlIGlmIChuZXcgUmVnRXhwKFwiKD86XnxcXFxccylcIiArIGNscyArIFwiKD86JHxcXFxccylcIikudGVzdChsaW5lW3Byb3BdKSkgcmV0dXJuIGZhbHNlO1xuICAgICAgICBlbHNlIGxpbmVbcHJvcF0gKz0gXCIgXCIgKyBjbHM7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSk7XG4gICAgfSksXG4gICAgcmVtb3ZlTGluZUNsYXNzOiBkb2NNZXRob2RPcChmdW5jdGlvbihoYW5kbGUsIHdoZXJlLCBjbHMpIHtcbiAgICAgIHJldHVybiBjaGFuZ2VMaW5lKHRoaXMsIGhhbmRsZSwgXCJjbGFzc1wiLCBmdW5jdGlvbihsaW5lKSB7XG4gICAgICAgIHZhciBwcm9wID0gd2hlcmUgPT0gXCJ0ZXh0XCIgPyBcInRleHRDbGFzc1wiIDogd2hlcmUgPT0gXCJiYWNrZ3JvdW5kXCIgPyBcImJnQ2xhc3NcIiA6IFwid3JhcENsYXNzXCI7XG4gICAgICAgIHZhciBjdXIgPSBsaW5lW3Byb3BdO1xuICAgICAgICBpZiAoIWN1cikgcmV0dXJuIGZhbHNlO1xuICAgICAgICBlbHNlIGlmIChjbHMgPT0gbnVsbCkgbGluZVtwcm9wXSA9IG51bGw7XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIHZhciBmb3VuZCA9IGN1ci5tYXRjaChuZXcgUmVnRXhwKFwiKD86XnxcXFxccyspXCIgKyBjbHMgKyBcIig/OiR8XFxcXHMrKVwiKSk7XG4gICAgICAgICAgaWYgKCFmb3VuZCkgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgIHZhciBlbmQgPSBmb3VuZC5pbmRleCArIGZvdW5kWzBdLmxlbmd0aDtcbiAgICAgICAgICBsaW5lW3Byb3BdID0gY3VyLnNsaWNlKDAsIGZvdW5kLmluZGV4KSArICghZm91bmQuaW5kZXggfHwgZW5kID09IGN1ci5sZW5ndGggPyBcIlwiIDogXCIgXCIpICsgY3VyLnNsaWNlKGVuZCkgfHwgbnVsbDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0pO1xuICAgIH0pLFxuXG4gICAgbWFya1RleHQ6IGZ1bmN0aW9uKGZyb20sIHRvLCBvcHRpb25zKSB7XG4gICAgICByZXR1cm4gbWFya1RleHQodGhpcywgY2xpcFBvcyh0aGlzLCBmcm9tKSwgY2xpcFBvcyh0aGlzLCB0byksIG9wdGlvbnMsIFwicmFuZ2VcIik7XG4gICAgfSxcbiAgICBzZXRCb29rbWFyazogZnVuY3Rpb24ocG9zLCBvcHRpb25zKSB7XG4gICAgICB2YXIgcmVhbE9wdHMgPSB7cmVwbGFjZWRXaXRoOiBvcHRpb25zICYmIChvcHRpb25zLm5vZGVUeXBlID09IG51bGwgPyBvcHRpb25zLndpZGdldCA6IG9wdGlvbnMpLFxuICAgICAgICAgICAgICAgICAgICAgIGluc2VydExlZnQ6IG9wdGlvbnMgJiYgb3B0aW9ucy5pbnNlcnRMZWZ0LFxuICAgICAgICAgICAgICAgICAgICAgIGNsZWFyV2hlbkVtcHR5OiBmYWxzZSwgc2hhcmVkOiBvcHRpb25zICYmIG9wdGlvbnMuc2hhcmVkfTtcbiAgICAgIHBvcyA9IGNsaXBQb3ModGhpcywgcG9zKTtcbiAgICAgIHJldHVybiBtYXJrVGV4dCh0aGlzLCBwb3MsIHBvcywgcmVhbE9wdHMsIFwiYm9va21hcmtcIik7XG4gICAgfSxcbiAgICBmaW5kTWFya3NBdDogZnVuY3Rpb24ocG9zKSB7XG4gICAgICBwb3MgPSBjbGlwUG9zKHRoaXMsIHBvcyk7XG4gICAgICB2YXIgbWFya2VycyA9IFtdLCBzcGFucyA9IGdldExpbmUodGhpcywgcG9zLmxpbmUpLm1hcmtlZFNwYW5zO1xuICAgICAgaWYgKHNwYW5zKSBmb3IgKHZhciBpID0gMDsgaSA8IHNwYW5zLmxlbmd0aDsgKytpKSB7XG4gICAgICAgIHZhciBzcGFuID0gc3BhbnNbaV07XG4gICAgICAgIGlmICgoc3Bhbi5mcm9tID09IG51bGwgfHwgc3Bhbi5mcm9tIDw9IHBvcy5jaCkgJiZcbiAgICAgICAgICAgIChzcGFuLnRvID09IG51bGwgfHwgc3Bhbi50byA+PSBwb3MuY2gpKVxuICAgICAgICAgIG1hcmtlcnMucHVzaChzcGFuLm1hcmtlci5wYXJlbnQgfHwgc3Bhbi5tYXJrZXIpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG1hcmtlcnM7XG4gICAgfSxcbiAgICBmaW5kTWFya3M6IGZ1bmN0aW9uKGZyb20sIHRvLCBmaWx0ZXIpIHtcbiAgICAgIGZyb20gPSBjbGlwUG9zKHRoaXMsIGZyb20pOyB0byA9IGNsaXBQb3ModGhpcywgdG8pO1xuICAgICAgdmFyIGZvdW5kID0gW10sIGxpbmVObyA9IGZyb20ubGluZTtcbiAgICAgIHRoaXMuaXRlcihmcm9tLmxpbmUsIHRvLmxpbmUgKyAxLCBmdW5jdGlvbihsaW5lKSB7XG4gICAgICAgIHZhciBzcGFucyA9IGxpbmUubWFya2VkU3BhbnM7XG4gICAgICAgIGlmIChzcGFucykgZm9yICh2YXIgaSA9IDA7IGkgPCBzcGFucy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgIHZhciBzcGFuID0gc3BhbnNbaV07XG4gICAgICAgICAgaWYgKCEobGluZU5vID09IGZyb20ubGluZSAmJiBmcm9tLmNoID4gc3Bhbi50byB8fFxuICAgICAgICAgICAgICAgIHNwYW4uZnJvbSA9PSBudWxsICYmIGxpbmVObyAhPSBmcm9tLmxpbmV8fFxuICAgICAgICAgICAgICAgIGxpbmVObyA9PSB0by5saW5lICYmIHNwYW4uZnJvbSA+IHRvLmNoKSAmJlxuICAgICAgICAgICAgICAoIWZpbHRlciB8fCBmaWx0ZXIoc3Bhbi5tYXJrZXIpKSlcbiAgICAgICAgICAgIGZvdW5kLnB1c2goc3Bhbi5tYXJrZXIucGFyZW50IHx8IHNwYW4ubWFya2VyKTtcbiAgICAgICAgfVxuICAgICAgICArK2xpbmVObztcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIGZvdW5kO1xuICAgIH0sXG4gICAgZ2V0QWxsTWFya3M6IGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIG1hcmtlcnMgPSBbXTtcbiAgICAgIHRoaXMuaXRlcihmdW5jdGlvbihsaW5lKSB7XG4gICAgICAgIHZhciBzcHMgPSBsaW5lLm1hcmtlZFNwYW5zO1xuICAgICAgICBpZiAoc3BzKSBmb3IgKHZhciBpID0gMDsgaSA8IHNwcy5sZW5ndGg7ICsraSlcbiAgICAgICAgICBpZiAoc3BzW2ldLmZyb20gIT0gbnVsbCkgbWFya2Vycy5wdXNoKHNwc1tpXS5tYXJrZXIpO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4gbWFya2VycztcbiAgICB9LFxuXG4gICAgcG9zRnJvbUluZGV4OiBmdW5jdGlvbihvZmYpIHtcbiAgICAgIHZhciBjaCwgbGluZU5vID0gdGhpcy5maXJzdDtcbiAgICAgIHRoaXMuaXRlcihmdW5jdGlvbihsaW5lKSB7XG4gICAgICAgIHZhciBzeiA9IGxpbmUudGV4dC5sZW5ndGggKyAxO1xuICAgICAgICBpZiAoc3ogPiBvZmYpIHsgY2ggPSBvZmY7IHJldHVybiB0cnVlOyB9XG4gICAgICAgIG9mZiAtPSBzejtcbiAgICAgICAgKytsaW5lTm87XG4gICAgICB9KTtcbiAgICAgIHJldHVybiBjbGlwUG9zKHRoaXMsIFBvcyhsaW5lTm8sIGNoKSk7XG4gICAgfSxcbiAgICBpbmRleEZyb21Qb3M6IGZ1bmN0aW9uIChjb29yZHMpIHtcbiAgICAgIGNvb3JkcyA9IGNsaXBQb3ModGhpcywgY29vcmRzKTtcbiAgICAgIHZhciBpbmRleCA9IGNvb3Jkcy5jaDtcbiAgICAgIGlmIChjb29yZHMubGluZSA8IHRoaXMuZmlyc3QgfHwgY29vcmRzLmNoIDwgMCkgcmV0dXJuIDA7XG4gICAgICB0aGlzLml0ZXIodGhpcy5maXJzdCwgY29vcmRzLmxpbmUsIGZ1bmN0aW9uIChsaW5lKSB7XG4gICAgICAgIGluZGV4ICs9IGxpbmUudGV4dC5sZW5ndGggKyAxO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4gaW5kZXg7XG4gICAgfSxcblxuICAgIGNvcHk6IGZ1bmN0aW9uKGNvcHlIaXN0b3J5KSB7XG4gICAgICB2YXIgZG9jID0gbmV3IERvYyhnZXRMaW5lcyh0aGlzLCB0aGlzLmZpcnN0LCB0aGlzLmZpcnN0ICsgdGhpcy5zaXplKSwgdGhpcy5tb2RlT3B0aW9uLCB0aGlzLmZpcnN0KTtcbiAgICAgIGRvYy5zY3JvbGxUb3AgPSB0aGlzLnNjcm9sbFRvcDsgZG9jLnNjcm9sbExlZnQgPSB0aGlzLnNjcm9sbExlZnQ7XG4gICAgICBkb2Muc2VsID0gdGhpcy5zZWw7XG4gICAgICBkb2MuZXh0ZW5kID0gZmFsc2U7XG4gICAgICBpZiAoY29weUhpc3RvcnkpIHtcbiAgICAgICAgZG9jLmhpc3RvcnkudW5kb0RlcHRoID0gdGhpcy5oaXN0b3J5LnVuZG9EZXB0aDtcbiAgICAgICAgZG9jLnNldEhpc3RvcnkodGhpcy5nZXRIaXN0b3J5KCkpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGRvYztcbiAgICB9LFxuXG4gICAgbGlua2VkRG9jOiBmdW5jdGlvbihvcHRpb25zKSB7XG4gICAgICBpZiAoIW9wdGlvbnMpIG9wdGlvbnMgPSB7fTtcbiAgICAgIHZhciBmcm9tID0gdGhpcy5maXJzdCwgdG8gPSB0aGlzLmZpcnN0ICsgdGhpcy5zaXplO1xuICAgICAgaWYgKG9wdGlvbnMuZnJvbSAhPSBudWxsICYmIG9wdGlvbnMuZnJvbSA+IGZyb20pIGZyb20gPSBvcHRpb25zLmZyb207XG4gICAgICBpZiAob3B0aW9ucy50byAhPSBudWxsICYmIG9wdGlvbnMudG8gPCB0bykgdG8gPSBvcHRpb25zLnRvO1xuICAgICAgdmFyIGNvcHkgPSBuZXcgRG9jKGdldExpbmVzKHRoaXMsIGZyb20sIHRvKSwgb3B0aW9ucy5tb2RlIHx8IHRoaXMubW9kZU9wdGlvbiwgZnJvbSk7XG4gICAgICBpZiAob3B0aW9ucy5zaGFyZWRIaXN0KSBjb3B5Lmhpc3RvcnkgPSB0aGlzLmhpc3Rvcnk7XG4gICAgICAodGhpcy5saW5rZWQgfHwgKHRoaXMubGlua2VkID0gW10pKS5wdXNoKHtkb2M6IGNvcHksIHNoYXJlZEhpc3Q6IG9wdGlvbnMuc2hhcmVkSGlzdH0pO1xuICAgICAgY29weS5saW5rZWQgPSBbe2RvYzogdGhpcywgaXNQYXJlbnQ6IHRydWUsIHNoYXJlZEhpc3Q6IG9wdGlvbnMuc2hhcmVkSGlzdH1dO1xuICAgICAgY29weVNoYXJlZE1hcmtlcnMoY29weSwgZmluZFNoYXJlZE1hcmtlcnModGhpcykpO1xuICAgICAgcmV0dXJuIGNvcHk7XG4gICAgfSxcbiAgICB1bmxpbmtEb2M6IGZ1bmN0aW9uKG90aGVyKSB7XG4gICAgICBpZiAob3RoZXIgaW5zdGFuY2VvZiBDb2RlTWlycm9yKSBvdGhlciA9IG90aGVyLmRvYztcbiAgICAgIGlmICh0aGlzLmxpbmtlZCkgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLmxpbmtlZC5sZW5ndGg7ICsraSkge1xuICAgICAgICB2YXIgbGluayA9IHRoaXMubGlua2VkW2ldO1xuICAgICAgICBpZiAobGluay5kb2MgIT0gb3RoZXIpIGNvbnRpbnVlO1xuICAgICAgICB0aGlzLmxpbmtlZC5zcGxpY2UoaSwgMSk7XG4gICAgICAgIG90aGVyLnVubGlua0RvYyh0aGlzKTtcbiAgICAgICAgZGV0YWNoU2hhcmVkTWFya2VycyhmaW5kU2hhcmVkTWFya2Vycyh0aGlzKSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgLy8gSWYgdGhlIGhpc3RvcmllcyB3ZXJlIHNoYXJlZCwgc3BsaXQgdGhlbSBhZ2FpblxuICAgICAgaWYgKG90aGVyLmhpc3RvcnkgPT0gdGhpcy5oaXN0b3J5KSB7XG4gICAgICAgIHZhciBzcGxpdElkcyA9IFtvdGhlci5pZF07XG4gICAgICAgIGxpbmtlZERvY3Mob3RoZXIsIGZ1bmN0aW9uKGRvYykge3NwbGl0SWRzLnB1c2goZG9jLmlkKTt9LCB0cnVlKTtcbiAgICAgICAgb3RoZXIuaGlzdG9yeSA9IG5ldyBIaXN0b3J5KG51bGwpO1xuICAgICAgICBvdGhlci5oaXN0b3J5LmRvbmUgPSBjb3B5SGlzdG9yeUFycmF5KHRoaXMuaGlzdG9yeS5kb25lLCBzcGxpdElkcyk7XG4gICAgICAgIG90aGVyLmhpc3RvcnkudW5kb25lID0gY29weUhpc3RvcnlBcnJheSh0aGlzLmhpc3RvcnkudW5kb25lLCBzcGxpdElkcyk7XG4gICAgICB9XG4gICAgfSxcbiAgICBpdGVyTGlua2VkRG9jczogZnVuY3Rpb24oZikge2xpbmtlZERvY3ModGhpcywgZik7fSxcblxuICAgIGdldE1vZGU6IGZ1bmN0aW9uKCkge3JldHVybiB0aGlzLm1vZGU7fSxcbiAgICBnZXRFZGl0b3I6IGZ1bmN0aW9uKCkge3JldHVybiB0aGlzLmNtO31cbiAgfSk7XG5cbiAgLy8gUHVibGljIGFsaWFzLlxuICBEb2MucHJvdG90eXBlLmVhY2hMaW5lID0gRG9jLnByb3RvdHlwZS5pdGVyO1xuXG4gIC8vIFNldCB1cCBtZXRob2RzIG9uIENvZGVNaXJyb3IncyBwcm90b3R5cGUgdG8gcmVkaXJlY3QgdG8gdGhlIGVkaXRvcidzIGRvY3VtZW50LlxuICB2YXIgZG9udERlbGVnYXRlID0gXCJpdGVyIGluc2VydCByZW1vdmUgY29weSBnZXRFZGl0b3JcIi5zcGxpdChcIiBcIik7XG4gIGZvciAodmFyIHByb3AgaW4gRG9jLnByb3RvdHlwZSkgaWYgKERvYy5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkocHJvcCkgJiYgaW5kZXhPZihkb250RGVsZWdhdGUsIHByb3ApIDwgMClcbiAgICBDb2RlTWlycm9yLnByb3RvdHlwZVtwcm9wXSA9IChmdW5jdGlvbihtZXRob2QpIHtcbiAgICAgIHJldHVybiBmdW5jdGlvbigpIHtyZXR1cm4gbWV0aG9kLmFwcGx5KHRoaXMuZG9jLCBhcmd1bWVudHMpO307XG4gICAgfSkoRG9jLnByb3RvdHlwZVtwcm9wXSk7XG5cbiAgZXZlbnRNaXhpbihEb2MpO1xuXG4gIC8vIENhbGwgZiBmb3IgYWxsIGxpbmtlZCBkb2N1bWVudHMuXG4gIGZ1bmN0aW9uIGxpbmtlZERvY3MoZG9jLCBmLCBzaGFyZWRIaXN0T25seSkge1xuICAgIGZ1bmN0aW9uIHByb3BhZ2F0ZShkb2MsIHNraXAsIHNoYXJlZEhpc3QpIHtcbiAgICAgIGlmIChkb2MubGlua2VkKSBmb3IgKHZhciBpID0gMDsgaSA8IGRvYy5saW5rZWQubGVuZ3RoOyArK2kpIHtcbiAgICAgICAgdmFyIHJlbCA9IGRvYy5saW5rZWRbaV07XG4gICAgICAgIGlmIChyZWwuZG9jID09IHNraXApIGNvbnRpbnVlO1xuICAgICAgICB2YXIgc2hhcmVkID0gc2hhcmVkSGlzdCAmJiByZWwuc2hhcmVkSGlzdDtcbiAgICAgICAgaWYgKHNoYXJlZEhpc3RPbmx5ICYmICFzaGFyZWQpIGNvbnRpbnVlO1xuICAgICAgICBmKHJlbC5kb2MsIHNoYXJlZCk7XG4gICAgICAgIHByb3BhZ2F0ZShyZWwuZG9jLCBkb2MsIHNoYXJlZCk7XG4gICAgICB9XG4gICAgfVxuICAgIHByb3BhZ2F0ZShkb2MsIG51bGwsIHRydWUpO1xuICB9XG5cbiAgLy8gQXR0YWNoIGEgZG9jdW1lbnQgdG8gYW4gZWRpdG9yLlxuICBmdW5jdGlvbiBhdHRhY2hEb2MoY20sIGRvYykge1xuICAgIGlmIChkb2MuY20pIHRocm93IG5ldyBFcnJvcihcIlRoaXMgZG9jdW1lbnQgaXMgYWxyZWFkeSBpbiB1c2UuXCIpO1xuICAgIGNtLmRvYyA9IGRvYztcbiAgICBkb2MuY20gPSBjbTtcbiAgICBlc3RpbWF0ZUxpbmVIZWlnaHRzKGNtKTtcbiAgICBsb2FkTW9kZShjbSk7XG4gICAgaWYgKCFjbS5vcHRpb25zLmxpbmVXcmFwcGluZykgZmluZE1heExpbmUoY20pO1xuICAgIGNtLm9wdGlvbnMubW9kZSA9IGRvYy5tb2RlT3B0aW9uO1xuICAgIHJlZ0NoYW5nZShjbSk7XG4gIH1cblxuICAvLyBMSU5FIFVUSUxJVElFU1xuXG4gIC8vIEZpbmQgdGhlIGxpbmUgb2JqZWN0IGNvcnJlc3BvbmRpbmcgdG8gdGhlIGdpdmVuIGxpbmUgbnVtYmVyLlxuICBmdW5jdGlvbiBnZXRMaW5lKGRvYywgbikge1xuICAgIG4gLT0gZG9jLmZpcnN0O1xuICAgIGlmIChuIDwgMCB8fCBuID49IGRvYy5zaXplKSB0aHJvdyBuZXcgRXJyb3IoXCJUaGVyZSBpcyBubyBsaW5lIFwiICsgKG4gKyBkb2MuZmlyc3QpICsgXCIgaW4gdGhlIGRvY3VtZW50LlwiKTtcbiAgICBmb3IgKHZhciBjaHVuayA9IGRvYzsgIWNodW5rLmxpbmVzOykge1xuICAgICAgZm9yICh2YXIgaSA9IDA7OyArK2kpIHtcbiAgICAgICAgdmFyIGNoaWxkID0gY2h1bmsuY2hpbGRyZW5baV0sIHN6ID0gY2hpbGQuY2h1bmtTaXplKCk7XG4gICAgICAgIGlmIChuIDwgc3opIHsgY2h1bmsgPSBjaGlsZDsgYnJlYWs7IH1cbiAgICAgICAgbiAtPSBzejtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGNodW5rLmxpbmVzW25dO1xuICB9XG5cbiAgLy8gR2V0IHRoZSBwYXJ0IG9mIGEgZG9jdW1lbnQgYmV0d2VlbiB0d28gcG9zaXRpb25zLCBhcyBhbiBhcnJheSBvZlxuICAvLyBzdHJpbmdzLlxuICBmdW5jdGlvbiBnZXRCZXR3ZWVuKGRvYywgc3RhcnQsIGVuZCkge1xuICAgIHZhciBvdXQgPSBbXSwgbiA9IHN0YXJ0LmxpbmU7XG4gICAgZG9jLml0ZXIoc3RhcnQubGluZSwgZW5kLmxpbmUgKyAxLCBmdW5jdGlvbihsaW5lKSB7XG4gICAgICB2YXIgdGV4dCA9IGxpbmUudGV4dDtcbiAgICAgIGlmIChuID09IGVuZC5saW5lKSB0ZXh0ID0gdGV4dC5zbGljZSgwLCBlbmQuY2gpO1xuICAgICAgaWYgKG4gPT0gc3RhcnQubGluZSkgdGV4dCA9IHRleHQuc2xpY2Uoc3RhcnQuY2gpO1xuICAgICAgb3V0LnB1c2godGV4dCk7XG4gICAgICArK247XG4gICAgfSk7XG4gICAgcmV0dXJuIG91dDtcbiAgfVxuICAvLyBHZXQgdGhlIGxpbmVzIGJldHdlZW4gZnJvbSBhbmQgdG8sIGFzIGFycmF5IG9mIHN0cmluZ3MuXG4gIGZ1bmN0aW9uIGdldExpbmVzKGRvYywgZnJvbSwgdG8pIHtcbiAgICB2YXIgb3V0ID0gW107XG4gICAgZG9jLml0ZXIoZnJvbSwgdG8sIGZ1bmN0aW9uKGxpbmUpIHsgb3V0LnB1c2gobGluZS50ZXh0KTsgfSk7XG4gICAgcmV0dXJuIG91dDtcbiAgfVxuXG4gIC8vIFVwZGF0ZSB0aGUgaGVpZ2h0IG9mIGEgbGluZSwgcHJvcGFnYXRpbmcgdGhlIGhlaWdodCBjaGFuZ2VcbiAgLy8gdXB3YXJkcyB0byBwYXJlbnQgbm9kZXMuXG4gIGZ1bmN0aW9uIHVwZGF0ZUxpbmVIZWlnaHQobGluZSwgaGVpZ2h0KSB7XG4gICAgdmFyIGRpZmYgPSBoZWlnaHQgLSBsaW5lLmhlaWdodDtcbiAgICBpZiAoZGlmZikgZm9yICh2YXIgbiA9IGxpbmU7IG47IG4gPSBuLnBhcmVudCkgbi5oZWlnaHQgKz0gZGlmZjtcbiAgfVxuXG4gIC8vIEdpdmVuIGEgbGluZSBvYmplY3QsIGZpbmQgaXRzIGxpbmUgbnVtYmVyIGJ5IHdhbGtpbmcgdXAgdGhyb3VnaFxuICAvLyBpdHMgcGFyZW50IGxpbmtzLlxuICBmdW5jdGlvbiBsaW5lTm8obGluZSkge1xuICAgIGlmIChsaW5lLnBhcmVudCA9PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgICB2YXIgY3VyID0gbGluZS5wYXJlbnQsIG5vID0gaW5kZXhPZihjdXIubGluZXMsIGxpbmUpO1xuICAgIGZvciAodmFyIGNodW5rID0gY3VyLnBhcmVudDsgY2h1bms7IGN1ciA9IGNodW5rLCBjaHVuayA9IGNodW5rLnBhcmVudCkge1xuICAgICAgZm9yICh2YXIgaSA9IDA7OyArK2kpIHtcbiAgICAgICAgaWYgKGNodW5rLmNoaWxkcmVuW2ldID09IGN1cikgYnJlYWs7XG4gICAgICAgIG5vICs9IGNodW5rLmNoaWxkcmVuW2ldLmNodW5rU2l6ZSgpO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gbm8gKyBjdXIuZmlyc3Q7XG4gIH1cblxuICAvLyBGaW5kIHRoZSBsaW5lIGF0IHRoZSBnaXZlbiB2ZXJ0aWNhbCBwb3NpdGlvbiwgdXNpbmcgdGhlIGhlaWdodFxuICAvLyBpbmZvcm1hdGlvbiBpbiB0aGUgZG9jdW1lbnQgdHJlZS5cbiAgZnVuY3Rpb24gbGluZUF0SGVpZ2h0KGNodW5rLCBoKSB7XG4gICAgdmFyIG4gPSBjaHVuay5maXJzdDtcbiAgICBvdXRlcjogZG8ge1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjaHVuay5jaGlsZHJlbi5sZW5ndGg7ICsraSkge1xuICAgICAgICB2YXIgY2hpbGQgPSBjaHVuay5jaGlsZHJlbltpXSwgY2ggPSBjaGlsZC5oZWlnaHQ7XG4gICAgICAgIGlmIChoIDwgY2gpIHsgY2h1bmsgPSBjaGlsZDsgY29udGludWUgb3V0ZXI7IH1cbiAgICAgICAgaCAtPSBjaDtcbiAgICAgICAgbiArPSBjaGlsZC5jaHVua1NpemUoKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBuO1xuICAgIH0gd2hpbGUgKCFjaHVuay5saW5lcyk7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjaHVuay5saW5lcy5sZW5ndGg7ICsraSkge1xuICAgICAgdmFyIGxpbmUgPSBjaHVuay5saW5lc1tpXSwgbGggPSBsaW5lLmhlaWdodDtcbiAgICAgIGlmIChoIDwgbGgpIGJyZWFrO1xuICAgICAgaCAtPSBsaDtcbiAgICB9XG4gICAgcmV0dXJuIG4gKyBpO1xuICB9XG5cblxuICAvLyBGaW5kIHRoZSBoZWlnaHQgYWJvdmUgdGhlIGdpdmVuIGxpbmUuXG4gIGZ1bmN0aW9uIGhlaWdodEF0TGluZShsaW5lT2JqKSB7XG4gICAgbGluZU9iaiA9IHZpc3VhbExpbmUobGluZU9iaik7XG5cbiAgICB2YXIgaCA9IDAsIGNodW5rID0gbGluZU9iai5wYXJlbnQ7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjaHVuay5saW5lcy5sZW5ndGg7ICsraSkge1xuICAgICAgdmFyIGxpbmUgPSBjaHVuay5saW5lc1tpXTtcbiAgICAgIGlmIChsaW5lID09IGxpbmVPYmopIGJyZWFrO1xuICAgICAgZWxzZSBoICs9IGxpbmUuaGVpZ2h0O1xuICAgIH1cbiAgICBmb3IgKHZhciBwID0gY2h1bmsucGFyZW50OyBwOyBjaHVuayA9IHAsIHAgPSBjaHVuay5wYXJlbnQpIHtcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgcC5jaGlsZHJlbi5sZW5ndGg7ICsraSkge1xuICAgICAgICB2YXIgY3VyID0gcC5jaGlsZHJlbltpXTtcbiAgICAgICAgaWYgKGN1ciA9PSBjaHVuaykgYnJlYWs7XG4gICAgICAgIGVsc2UgaCArPSBjdXIuaGVpZ2h0O1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gaDtcbiAgfVxuXG4gIC8vIEdldCB0aGUgYmlkaSBvcmRlcmluZyBmb3IgdGhlIGdpdmVuIGxpbmUgKGFuZCBjYWNoZSBpdCkuIFJldHVybnNcbiAgLy8gZmFsc2UgZm9yIGxpbmVzIHRoYXQgYXJlIGZ1bGx5IGxlZnQtdG8tcmlnaHQsIGFuZCBhbiBhcnJheSBvZlxuICAvLyBCaWRpU3BhbiBvYmplY3RzIG90aGVyd2lzZS5cbiAgZnVuY3Rpb24gZ2V0T3JkZXIobGluZSkge1xuICAgIHZhciBvcmRlciA9IGxpbmUub3JkZXI7XG4gICAgaWYgKG9yZGVyID09IG51bGwpIG9yZGVyID0gbGluZS5vcmRlciA9IGJpZGlPcmRlcmluZyhsaW5lLnRleHQpO1xuICAgIHJldHVybiBvcmRlcjtcbiAgfVxuXG4gIC8vIEhJU1RPUllcblxuICBmdW5jdGlvbiBIaXN0b3J5KHN0YXJ0R2VuKSB7XG4gICAgLy8gQXJyYXlzIG9mIGNoYW5nZSBldmVudHMgYW5kIHNlbGVjdGlvbnMuIERvaW5nIHNvbWV0aGluZyBhZGRzIGFuXG4gICAgLy8gZXZlbnQgdG8gZG9uZSBhbmQgY2xlYXJzIHVuZG8uIFVuZG9pbmcgbW92ZXMgZXZlbnRzIGZyb20gZG9uZVxuICAgIC8vIHRvIHVuZG9uZSwgcmVkb2luZyBtb3ZlcyB0aGVtIGluIHRoZSBvdGhlciBkaXJlY3Rpb24uXG4gICAgdGhpcy5kb25lID0gW107IHRoaXMudW5kb25lID0gW107XG4gICAgdGhpcy51bmRvRGVwdGggPSBJbmZpbml0eTtcbiAgICAvLyBVc2VkIHRvIHRyYWNrIHdoZW4gY2hhbmdlcyBjYW4gYmUgbWVyZ2VkIGludG8gYSBzaW5nbGUgdW5kb1xuICAgIC8vIGV2ZW50XG4gICAgdGhpcy5sYXN0TW9kVGltZSA9IHRoaXMubGFzdFNlbFRpbWUgPSAwO1xuICAgIHRoaXMubGFzdE9wID0gbnVsbDtcbiAgICB0aGlzLmxhc3RPcmlnaW4gPSB0aGlzLmxhc3RTZWxPcmlnaW4gPSBudWxsO1xuICAgIC8vIFVzZWQgYnkgdGhlIGlzQ2xlYW4oKSBtZXRob2RcbiAgICB0aGlzLmdlbmVyYXRpb24gPSB0aGlzLm1heEdlbmVyYXRpb24gPSBzdGFydEdlbiB8fCAxO1xuICB9XG5cbiAgLy8gQ3JlYXRlIGEgaGlzdG9yeSBjaGFuZ2UgZXZlbnQgZnJvbSBhbiB1cGRhdGVEb2Mtc3R5bGUgY2hhbmdlXG4gIC8vIG9iamVjdC5cbiAgZnVuY3Rpb24gaGlzdG9yeUNoYW5nZUZyb21DaGFuZ2UoZG9jLCBjaGFuZ2UpIHtcbiAgICB2YXIgaGlzdENoYW5nZSA9IHtmcm9tOiBjb3B5UG9zKGNoYW5nZS5mcm9tKSwgdG86IGNoYW5nZUVuZChjaGFuZ2UpLCB0ZXh0OiBnZXRCZXR3ZWVuKGRvYywgY2hhbmdlLmZyb20sIGNoYW5nZS50byl9O1xuICAgIGF0dGFjaExvY2FsU3BhbnMoZG9jLCBoaXN0Q2hhbmdlLCBjaGFuZ2UuZnJvbS5saW5lLCBjaGFuZ2UudG8ubGluZSArIDEpO1xuICAgIGxpbmtlZERvY3MoZG9jLCBmdW5jdGlvbihkb2MpIHthdHRhY2hMb2NhbFNwYW5zKGRvYywgaGlzdENoYW5nZSwgY2hhbmdlLmZyb20ubGluZSwgY2hhbmdlLnRvLmxpbmUgKyAxKTt9LCB0cnVlKTtcbiAgICByZXR1cm4gaGlzdENoYW5nZTtcbiAgfVxuXG4gIC8vIFBvcCBhbGwgc2VsZWN0aW9uIGV2ZW50cyBvZmYgdGhlIGVuZCBvZiBhIGhpc3RvcnkgYXJyYXkuIFN0b3AgYXRcbiAgLy8gYSBjaGFuZ2UgZXZlbnQuXG4gIGZ1bmN0aW9uIGNsZWFyU2VsZWN0aW9uRXZlbnRzKGFycmF5KSB7XG4gICAgd2hpbGUgKGFycmF5Lmxlbmd0aCkge1xuICAgICAgdmFyIGxhc3QgPSBsc3QoYXJyYXkpO1xuICAgICAgaWYgKGxhc3QucmFuZ2VzKSBhcnJheS5wb3AoKTtcbiAgICAgIGVsc2UgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgLy8gRmluZCB0aGUgdG9wIGNoYW5nZSBldmVudCBpbiB0aGUgaGlzdG9yeS4gUG9wIG9mZiBzZWxlY3Rpb25cbiAgLy8gZXZlbnRzIHRoYXQgYXJlIGluIHRoZSB3YXkuXG4gIGZ1bmN0aW9uIGxhc3RDaGFuZ2VFdmVudChoaXN0LCBmb3JjZSkge1xuICAgIGlmIChmb3JjZSkge1xuICAgICAgY2xlYXJTZWxlY3Rpb25FdmVudHMoaGlzdC5kb25lKTtcbiAgICAgIHJldHVybiBsc3QoaGlzdC5kb25lKTtcbiAgICB9IGVsc2UgaWYgKGhpc3QuZG9uZS5sZW5ndGggJiYgIWxzdChoaXN0LmRvbmUpLnJhbmdlcykge1xuICAgICAgcmV0dXJuIGxzdChoaXN0LmRvbmUpO1xuICAgIH0gZWxzZSBpZiAoaGlzdC5kb25lLmxlbmd0aCA+IDEgJiYgIWhpc3QuZG9uZVtoaXN0LmRvbmUubGVuZ3RoIC0gMl0ucmFuZ2VzKSB7XG4gICAgICBoaXN0LmRvbmUucG9wKCk7XG4gICAgICByZXR1cm4gbHN0KGhpc3QuZG9uZSk7XG4gICAgfVxuICB9XG5cbiAgLy8gUmVnaXN0ZXIgYSBjaGFuZ2UgaW4gdGhlIGhpc3RvcnkuIE1lcmdlcyBjaGFuZ2VzIHRoYXQgYXJlIHdpdGhpblxuICAvLyBhIHNpbmdsZSBvcGVyYXRpb24sIG9yZSBhcmUgY2xvc2UgdG9nZXRoZXIgd2l0aCBhbiBvcmlnaW4gdGhhdFxuICAvLyBhbGxvd3MgbWVyZ2luZyAoc3RhcnRpbmcgd2l0aCBcIitcIikgaW50byBhIHNpbmdsZSBldmVudC5cbiAgZnVuY3Rpb24gYWRkQ2hhbmdlVG9IaXN0b3J5KGRvYywgY2hhbmdlLCBzZWxBZnRlciwgb3BJZCkge1xuICAgIHZhciBoaXN0ID0gZG9jLmhpc3Rvcnk7XG4gICAgaGlzdC51bmRvbmUubGVuZ3RoID0gMDtcbiAgICB2YXIgdGltZSA9ICtuZXcgRGF0ZSwgY3VyO1xuXG4gICAgaWYgKChoaXN0Lmxhc3RPcCA9PSBvcElkIHx8XG4gICAgICAgICBoaXN0Lmxhc3RPcmlnaW4gPT0gY2hhbmdlLm9yaWdpbiAmJiBjaGFuZ2Uub3JpZ2luICYmXG4gICAgICAgICAoKGNoYW5nZS5vcmlnaW4uY2hhckF0KDApID09IFwiK1wiICYmIGRvYy5jbSAmJiBoaXN0Lmxhc3RNb2RUaW1lID4gdGltZSAtIGRvYy5jbS5vcHRpb25zLmhpc3RvcnlFdmVudERlbGF5KSB8fFxuICAgICAgICAgIGNoYW5nZS5vcmlnaW4uY2hhckF0KDApID09IFwiKlwiKSkgJiZcbiAgICAgICAgKGN1ciA9IGxhc3RDaGFuZ2VFdmVudChoaXN0LCBoaXN0Lmxhc3RPcCA9PSBvcElkKSkpIHtcbiAgICAgIC8vIE1lcmdlIHRoaXMgY2hhbmdlIGludG8gdGhlIGxhc3QgZXZlbnRcbiAgICAgIHZhciBsYXN0ID0gbHN0KGN1ci5jaGFuZ2VzKTtcbiAgICAgIGlmIChjbXAoY2hhbmdlLmZyb20sIGNoYW5nZS50bykgPT0gMCAmJiBjbXAoY2hhbmdlLmZyb20sIGxhc3QudG8pID09IDApIHtcbiAgICAgICAgLy8gT3B0aW1pemVkIGNhc2UgZm9yIHNpbXBsZSBpbnNlcnRpb24gLS0gZG9uJ3Qgd2FudCB0byBhZGRcbiAgICAgICAgLy8gbmV3IGNoYW5nZXNldHMgZm9yIGV2ZXJ5IGNoYXJhY3RlciB0eXBlZFxuICAgICAgICBsYXN0LnRvID0gY2hhbmdlRW5kKGNoYW5nZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBBZGQgbmV3IHN1Yi1ldmVudFxuICAgICAgICBjdXIuY2hhbmdlcy5wdXNoKGhpc3RvcnlDaGFuZ2VGcm9tQ2hhbmdlKGRvYywgY2hhbmdlKSk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIENhbiBub3QgYmUgbWVyZ2VkLCBzdGFydCBhIG5ldyBldmVudC5cbiAgICAgIHZhciBiZWZvcmUgPSBsc3QoaGlzdC5kb25lKTtcbiAgICAgIGlmICghYmVmb3JlIHx8ICFiZWZvcmUucmFuZ2VzKVxuICAgICAgICBwdXNoU2VsZWN0aW9uVG9IaXN0b3J5KGRvYy5zZWwsIGhpc3QuZG9uZSk7XG4gICAgICBjdXIgPSB7Y2hhbmdlczogW2hpc3RvcnlDaGFuZ2VGcm9tQ2hhbmdlKGRvYywgY2hhbmdlKV0sXG4gICAgICAgICAgICAgZ2VuZXJhdGlvbjogaGlzdC5nZW5lcmF0aW9ufTtcbiAgICAgIGhpc3QuZG9uZS5wdXNoKGN1cik7XG4gICAgICB3aGlsZSAoaGlzdC5kb25lLmxlbmd0aCA+IGhpc3QudW5kb0RlcHRoKSB7XG4gICAgICAgIGhpc3QuZG9uZS5zaGlmdCgpO1xuICAgICAgICBpZiAoIWhpc3QuZG9uZVswXS5yYW5nZXMpIGhpc3QuZG9uZS5zaGlmdCgpO1xuICAgICAgfVxuICAgIH1cbiAgICBoaXN0LmRvbmUucHVzaChzZWxBZnRlcik7XG4gICAgaGlzdC5nZW5lcmF0aW9uID0gKytoaXN0Lm1heEdlbmVyYXRpb247XG4gICAgaGlzdC5sYXN0TW9kVGltZSA9IGhpc3QubGFzdFNlbFRpbWUgPSB0aW1lO1xuICAgIGhpc3QubGFzdE9wID0gb3BJZDtcbiAgICBoaXN0Lmxhc3RPcmlnaW4gPSBoaXN0Lmxhc3RTZWxPcmlnaW4gPSBjaGFuZ2Uub3JpZ2luO1xuXG4gICAgaWYgKCFsYXN0KSBzaWduYWwoZG9jLCBcImhpc3RvcnlBZGRlZFwiKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHNlbGVjdGlvbkV2ZW50Q2FuQmVNZXJnZWQoZG9jLCBvcmlnaW4sIHByZXYsIHNlbCkge1xuICAgIHZhciBjaCA9IG9yaWdpbi5jaGFyQXQoMCk7XG4gICAgcmV0dXJuIGNoID09IFwiKlwiIHx8XG4gICAgICBjaCA9PSBcIitcIiAmJlxuICAgICAgcHJldi5yYW5nZXMubGVuZ3RoID09IHNlbC5yYW5nZXMubGVuZ3RoICYmXG4gICAgICBwcmV2LnNvbWV0aGluZ1NlbGVjdGVkKCkgPT0gc2VsLnNvbWV0aGluZ1NlbGVjdGVkKCkgJiZcbiAgICAgIG5ldyBEYXRlIC0gZG9jLmhpc3RvcnkubGFzdFNlbFRpbWUgPD0gKGRvYy5jbSA/IGRvYy5jbS5vcHRpb25zLmhpc3RvcnlFdmVudERlbGF5IDogNTAwKTtcbiAgfVxuXG4gIC8vIENhbGxlZCB3aGVuZXZlciB0aGUgc2VsZWN0aW9uIGNoYW5nZXMsIHNldHMgdGhlIG5ldyBzZWxlY3Rpb24gYXNcbiAgLy8gdGhlIHBlbmRpbmcgc2VsZWN0aW9uIGluIHRoZSBoaXN0b3J5LCBhbmQgcHVzaGVzIHRoZSBvbGQgcGVuZGluZ1xuICAvLyBzZWxlY3Rpb24gaW50byB0aGUgJ2RvbmUnIGFycmF5IHdoZW4gaXQgd2FzIHNpZ25pZmljYW50bHlcbiAgLy8gZGlmZmVyZW50IChpbiBudW1iZXIgb2Ygc2VsZWN0ZWQgcmFuZ2VzLCBlbXB0aW5lc3MsIG9yIHRpbWUpLlxuICBmdW5jdGlvbiBhZGRTZWxlY3Rpb25Ub0hpc3RvcnkoZG9jLCBzZWwsIG9wSWQsIG9wdGlvbnMpIHtcbiAgICB2YXIgaGlzdCA9IGRvYy5oaXN0b3J5LCBvcmlnaW4gPSBvcHRpb25zICYmIG9wdGlvbnMub3JpZ2luO1xuXG4gICAgLy8gQSBuZXcgZXZlbnQgaXMgc3RhcnRlZCB3aGVuIHRoZSBwcmV2aW91cyBvcmlnaW4gZG9lcyBub3QgbWF0Y2hcbiAgICAvLyB0aGUgY3VycmVudCwgb3IgdGhlIG9yaWdpbnMgZG9uJ3QgYWxsb3cgbWF0Y2hpbmcuIE9yaWdpbnNcbiAgICAvLyBzdGFydGluZyB3aXRoICogYXJlIGFsd2F5cyBtZXJnZWQsIHRob3NlIHN0YXJ0aW5nIHdpdGggKyBhcmVcbiAgICAvLyBtZXJnZWQgd2hlbiBzaW1pbGFyIGFuZCBjbG9zZSB0b2dldGhlciBpbiB0aW1lLlxuICAgIGlmIChvcElkID09IGhpc3QubGFzdE9wIHx8XG4gICAgICAgIChvcmlnaW4gJiYgaGlzdC5sYXN0U2VsT3JpZ2luID09IG9yaWdpbiAmJlxuICAgICAgICAgKGhpc3QubGFzdE1vZFRpbWUgPT0gaGlzdC5sYXN0U2VsVGltZSAmJiBoaXN0Lmxhc3RPcmlnaW4gPT0gb3JpZ2luIHx8XG4gICAgICAgICAgc2VsZWN0aW9uRXZlbnRDYW5CZU1lcmdlZChkb2MsIG9yaWdpbiwgbHN0KGhpc3QuZG9uZSksIHNlbCkpKSlcbiAgICAgIGhpc3QuZG9uZVtoaXN0LmRvbmUubGVuZ3RoIC0gMV0gPSBzZWw7XG4gICAgZWxzZVxuICAgICAgcHVzaFNlbGVjdGlvblRvSGlzdG9yeShzZWwsIGhpc3QuZG9uZSk7XG5cbiAgICBoaXN0Lmxhc3RTZWxUaW1lID0gK25ldyBEYXRlO1xuICAgIGhpc3QubGFzdFNlbE9yaWdpbiA9IG9yaWdpbjtcbiAgICBoaXN0Lmxhc3RPcCA9IG9wSWQ7XG4gICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5jbGVhclJlZG8gIT09IGZhbHNlKVxuICAgICAgY2xlYXJTZWxlY3Rpb25FdmVudHMoaGlzdC51bmRvbmUpO1xuICB9XG5cbiAgZnVuY3Rpb24gcHVzaFNlbGVjdGlvblRvSGlzdG9yeShzZWwsIGRlc3QpIHtcbiAgICB2YXIgdG9wID0gbHN0KGRlc3QpO1xuICAgIGlmICghKHRvcCAmJiB0b3AucmFuZ2VzICYmIHRvcC5lcXVhbHMoc2VsKSkpXG4gICAgICBkZXN0LnB1c2goc2VsKTtcbiAgfVxuXG4gIC8vIFVzZWQgdG8gc3RvcmUgbWFya2VkIHNwYW4gaW5mb3JtYXRpb24gaW4gdGhlIGhpc3RvcnkuXG4gIGZ1bmN0aW9uIGF0dGFjaExvY2FsU3BhbnMoZG9jLCBjaGFuZ2UsIGZyb20sIHRvKSB7XG4gICAgdmFyIGV4aXN0aW5nID0gY2hhbmdlW1wic3BhbnNfXCIgKyBkb2MuaWRdLCBuID0gMDtcbiAgICBkb2MuaXRlcihNYXRoLm1heChkb2MuZmlyc3QsIGZyb20pLCBNYXRoLm1pbihkb2MuZmlyc3QgKyBkb2Muc2l6ZSwgdG8pLCBmdW5jdGlvbihsaW5lKSB7XG4gICAgICBpZiAobGluZS5tYXJrZWRTcGFucylcbiAgICAgICAgKGV4aXN0aW5nIHx8IChleGlzdGluZyA9IGNoYW5nZVtcInNwYW5zX1wiICsgZG9jLmlkXSA9IHt9KSlbbl0gPSBsaW5lLm1hcmtlZFNwYW5zO1xuICAgICAgKytuO1xuICAgIH0pO1xuICB9XG5cbiAgLy8gV2hlbiB1bi9yZS1kb2luZyByZXN0b3JlcyB0ZXh0IGNvbnRhaW5pbmcgbWFya2VkIHNwYW5zLCB0aG9zZVxuICAvLyB0aGF0IGhhdmUgYmVlbiBleHBsaWNpdGx5IGNsZWFyZWQgc2hvdWxkIG5vdCBiZSByZXN0b3JlZC5cbiAgZnVuY3Rpb24gcmVtb3ZlQ2xlYXJlZFNwYW5zKHNwYW5zKSB7XG4gICAgaWYgKCFzcGFucykgcmV0dXJuIG51bGw7XG4gICAgZm9yICh2YXIgaSA9IDAsIG91dDsgaSA8IHNwYW5zLmxlbmd0aDsgKytpKSB7XG4gICAgICBpZiAoc3BhbnNbaV0ubWFya2VyLmV4cGxpY2l0bHlDbGVhcmVkKSB7IGlmICghb3V0KSBvdXQgPSBzcGFucy5zbGljZSgwLCBpKTsgfVxuICAgICAgZWxzZSBpZiAob3V0KSBvdXQucHVzaChzcGFuc1tpXSk7XG4gICAgfVxuICAgIHJldHVybiAhb3V0ID8gc3BhbnMgOiBvdXQubGVuZ3RoID8gb3V0IDogbnVsbDtcbiAgfVxuXG4gIC8vIFJldHJpZXZlIGFuZCBmaWx0ZXIgdGhlIG9sZCBtYXJrZWQgc3BhbnMgc3RvcmVkIGluIGEgY2hhbmdlIGV2ZW50LlxuICBmdW5jdGlvbiBnZXRPbGRTcGFucyhkb2MsIGNoYW5nZSkge1xuICAgIHZhciBmb3VuZCA9IGNoYW5nZVtcInNwYW5zX1wiICsgZG9jLmlkXTtcbiAgICBpZiAoIWZvdW5kKSByZXR1cm4gbnVsbDtcbiAgICBmb3IgKHZhciBpID0gMCwgbncgPSBbXTsgaSA8IGNoYW5nZS50ZXh0Lmxlbmd0aDsgKytpKVxuICAgICAgbncucHVzaChyZW1vdmVDbGVhcmVkU3BhbnMoZm91bmRbaV0pKTtcbiAgICByZXR1cm4gbnc7XG4gIH1cblxuICAvLyBVc2VkIGJvdGggdG8gcHJvdmlkZSBhIEpTT04tc2FmZSBvYmplY3QgaW4gLmdldEhpc3RvcnksIGFuZCwgd2hlblxuICAvLyBkZXRhY2hpbmcgYSBkb2N1bWVudCwgdG8gc3BsaXQgdGhlIGhpc3RvcnkgaW4gdHdvXG4gIGZ1bmN0aW9uIGNvcHlIaXN0b3J5QXJyYXkoZXZlbnRzLCBuZXdHcm91cCwgaW5zdGFudGlhdGVTZWwpIHtcbiAgICBmb3IgKHZhciBpID0gMCwgY29weSA9IFtdOyBpIDwgZXZlbnRzLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YXIgZXZlbnQgPSBldmVudHNbaV07XG4gICAgICBpZiAoZXZlbnQucmFuZ2VzKSB7XG4gICAgICAgIGNvcHkucHVzaChpbnN0YW50aWF0ZVNlbCA/IFNlbGVjdGlvbi5wcm90b3R5cGUuZGVlcENvcHkuY2FsbChldmVudCkgOiBldmVudCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgdmFyIGNoYW5nZXMgPSBldmVudC5jaGFuZ2VzLCBuZXdDaGFuZ2VzID0gW107XG4gICAgICBjb3B5LnB1c2goe2NoYW5nZXM6IG5ld0NoYW5nZXN9KTtcbiAgICAgIGZvciAodmFyIGogPSAwOyBqIDwgY2hhbmdlcy5sZW5ndGg7ICsraikge1xuICAgICAgICB2YXIgY2hhbmdlID0gY2hhbmdlc1tqXSwgbTtcbiAgICAgICAgbmV3Q2hhbmdlcy5wdXNoKHtmcm9tOiBjaGFuZ2UuZnJvbSwgdG86IGNoYW5nZS50bywgdGV4dDogY2hhbmdlLnRleHR9KTtcbiAgICAgICAgaWYgKG5ld0dyb3VwKSBmb3IgKHZhciBwcm9wIGluIGNoYW5nZSkgaWYgKG0gPSBwcm9wLm1hdGNoKC9ec3BhbnNfKFxcZCspJC8pKSB7XG4gICAgICAgICAgaWYgKGluZGV4T2YobmV3R3JvdXAsIE51bWJlcihtWzFdKSkgPiAtMSkge1xuICAgICAgICAgICAgbHN0KG5ld0NoYW5nZXMpW3Byb3BdID0gY2hhbmdlW3Byb3BdO1xuICAgICAgICAgICAgZGVsZXRlIGNoYW5nZVtwcm9wXTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGNvcHk7XG4gIH1cblxuICAvLyBSZWJhc2luZy9yZXNldHRpbmcgaGlzdG9yeSB0byBkZWFsIHdpdGggZXh0ZXJuYWxseS1zb3VyY2VkIGNoYW5nZXNcblxuICBmdW5jdGlvbiByZWJhc2VIaXN0U2VsU2luZ2xlKHBvcywgZnJvbSwgdG8sIGRpZmYpIHtcbiAgICBpZiAodG8gPCBwb3MubGluZSkge1xuICAgICAgcG9zLmxpbmUgKz0gZGlmZjtcbiAgICB9IGVsc2UgaWYgKGZyb20gPCBwb3MubGluZSkge1xuICAgICAgcG9zLmxpbmUgPSBmcm9tO1xuICAgICAgcG9zLmNoID0gMDtcbiAgICB9XG4gIH1cblxuICAvLyBUcmllcyB0byByZWJhc2UgYW4gYXJyYXkgb2YgaGlzdG9yeSBldmVudHMgZ2l2ZW4gYSBjaGFuZ2UgaW4gdGhlXG4gIC8vIGRvY3VtZW50LiBJZiB0aGUgY2hhbmdlIHRvdWNoZXMgdGhlIHNhbWUgbGluZXMgYXMgdGhlIGV2ZW50LCB0aGVcbiAgLy8gZXZlbnQsIGFuZCBldmVyeXRoaW5nICdiZWhpbmQnIGl0LCBpcyBkaXNjYXJkZWQuIElmIHRoZSBjaGFuZ2UgaXNcbiAgLy8gYmVmb3JlIHRoZSBldmVudCwgdGhlIGV2ZW50J3MgcG9zaXRpb25zIGFyZSB1cGRhdGVkLiBVc2VzIGFcbiAgLy8gY29weS1vbi13cml0ZSBzY2hlbWUgZm9yIHRoZSBwb3NpdGlvbnMsIHRvIGF2b2lkIGhhdmluZyB0b1xuICAvLyByZWFsbG9jYXRlIHRoZW0gYWxsIG9uIGV2ZXJ5IHJlYmFzZSwgYnV0IGFsc28gYXZvaWQgcHJvYmxlbXMgd2l0aFxuICAvLyBzaGFyZWQgcG9zaXRpb24gb2JqZWN0cyBiZWluZyB1bnNhZmVseSB1cGRhdGVkLlxuICBmdW5jdGlvbiByZWJhc2VIaXN0QXJyYXkoYXJyYXksIGZyb20sIHRvLCBkaWZmKSB7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBhcnJheS5sZW5ndGg7ICsraSkge1xuICAgICAgdmFyIHN1YiA9IGFycmF5W2ldLCBvayA9IHRydWU7XG4gICAgICBpZiAoc3ViLnJhbmdlcykge1xuICAgICAgICBpZiAoIXN1Yi5jb3BpZWQpIHsgc3ViID0gYXJyYXlbaV0gPSBzdWIuZGVlcENvcHkoKTsgc3ViLmNvcGllZCA9IHRydWU7IH1cbiAgICAgICAgZm9yICh2YXIgaiA9IDA7IGogPCBzdWIucmFuZ2VzLmxlbmd0aDsgaisrKSB7XG4gICAgICAgICAgcmViYXNlSGlzdFNlbFNpbmdsZShzdWIucmFuZ2VzW2pdLmFuY2hvciwgZnJvbSwgdG8sIGRpZmYpO1xuICAgICAgICAgIHJlYmFzZUhpc3RTZWxTaW5nbGUoc3ViLnJhbmdlc1tqXS5oZWFkLCBmcm9tLCB0bywgZGlmZik7XG4gICAgICAgIH1cbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBmb3IgKHZhciBqID0gMDsgaiA8IHN1Yi5jaGFuZ2VzLmxlbmd0aDsgKytqKSB7XG4gICAgICAgIHZhciBjdXIgPSBzdWIuY2hhbmdlc1tqXTtcbiAgICAgICAgaWYgKHRvIDwgY3VyLmZyb20ubGluZSkge1xuICAgICAgICAgIGN1ci5mcm9tID0gUG9zKGN1ci5mcm9tLmxpbmUgKyBkaWZmLCBjdXIuZnJvbS5jaCk7XG4gICAgICAgICAgY3VyLnRvID0gUG9zKGN1ci50by5saW5lICsgZGlmZiwgY3VyLnRvLmNoKTtcbiAgICAgICAgfSBlbHNlIGlmIChmcm9tIDw9IGN1ci50by5saW5lKSB7XG4gICAgICAgICAgb2sgPSBmYWxzZTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKCFvaykge1xuICAgICAgICBhcnJheS5zcGxpY2UoMCwgaSArIDEpO1xuICAgICAgICBpID0gMDtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiByZWJhc2VIaXN0KGhpc3QsIGNoYW5nZSkge1xuICAgIHZhciBmcm9tID0gY2hhbmdlLmZyb20ubGluZSwgdG8gPSBjaGFuZ2UudG8ubGluZSwgZGlmZiA9IGNoYW5nZS50ZXh0Lmxlbmd0aCAtICh0byAtIGZyb20pIC0gMTtcbiAgICByZWJhc2VIaXN0QXJyYXkoaGlzdC5kb25lLCBmcm9tLCB0bywgZGlmZik7XG4gICAgcmViYXNlSGlzdEFycmF5KGhpc3QudW5kb25lLCBmcm9tLCB0bywgZGlmZik7XG4gIH1cblxuICAvLyBFVkVOVCBVVElMSVRJRVNcblxuICAvLyBEdWUgdG8gdGhlIGZhY3QgdGhhdCB3ZSBzdGlsbCBzdXBwb3J0IGp1cmFzc2ljIElFIHZlcnNpb25zLCBzb21lXG4gIC8vIGNvbXBhdGliaWxpdHkgd3JhcHBlcnMgYXJlIG5lZWRlZC5cblxuICB2YXIgZV9wcmV2ZW50RGVmYXVsdCA9IENvZGVNaXJyb3IuZV9wcmV2ZW50RGVmYXVsdCA9IGZ1bmN0aW9uKGUpIHtcbiAgICBpZiAoZS5wcmV2ZW50RGVmYXVsdCkgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGVsc2UgZS5yZXR1cm5WYWx1ZSA9IGZhbHNlO1xuICB9O1xuICB2YXIgZV9zdG9wUHJvcGFnYXRpb24gPSBDb2RlTWlycm9yLmVfc3RvcFByb3BhZ2F0aW9uID0gZnVuY3Rpb24oZSkge1xuICAgIGlmIChlLnN0b3BQcm9wYWdhdGlvbikgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBlbHNlIGUuY2FuY2VsQnViYmxlID0gdHJ1ZTtcbiAgfTtcbiAgZnVuY3Rpb24gZV9kZWZhdWx0UHJldmVudGVkKGUpIHtcbiAgICByZXR1cm4gZS5kZWZhdWx0UHJldmVudGVkICE9IG51bGwgPyBlLmRlZmF1bHRQcmV2ZW50ZWQgOiBlLnJldHVyblZhbHVlID09IGZhbHNlO1xuICB9XG4gIHZhciBlX3N0b3AgPSBDb2RlTWlycm9yLmVfc3RvcCA9IGZ1bmN0aW9uKGUpIHtlX3ByZXZlbnREZWZhdWx0KGUpOyBlX3N0b3BQcm9wYWdhdGlvbihlKTt9O1xuXG4gIGZ1bmN0aW9uIGVfdGFyZ2V0KGUpIHtyZXR1cm4gZS50YXJnZXQgfHwgZS5zcmNFbGVtZW50O31cbiAgZnVuY3Rpb24gZV9idXR0b24oZSkge1xuICAgIHZhciBiID0gZS53aGljaDtcbiAgICBpZiAoYiA9PSBudWxsKSB7XG4gICAgICBpZiAoZS5idXR0b24gJiAxKSBiID0gMTtcbiAgICAgIGVsc2UgaWYgKGUuYnV0dG9uICYgMikgYiA9IDM7XG4gICAgICBlbHNlIGlmIChlLmJ1dHRvbiAmIDQpIGIgPSAyO1xuICAgIH1cbiAgICBpZiAobWFjICYmIGUuY3RybEtleSAmJiBiID09IDEpIGIgPSAzO1xuICAgIHJldHVybiBiO1xuICB9XG5cbiAgLy8gRVZFTlQgSEFORExJTkdcblxuICAvLyBMaWdodHdlaWdodCBldmVudCBmcmFtZXdvcmsuIG9uL29mZiBhbHNvIHdvcmsgb24gRE9NIG5vZGVzLFxuICAvLyByZWdpc3RlcmluZyBuYXRpdmUgRE9NIGhhbmRsZXJzLlxuXG4gIHZhciBvbiA9IENvZGVNaXJyb3Iub24gPSBmdW5jdGlvbihlbWl0dGVyLCB0eXBlLCBmKSB7XG4gICAgaWYgKGVtaXR0ZXIuYWRkRXZlbnRMaXN0ZW5lcilcbiAgICAgIGVtaXR0ZXIuYWRkRXZlbnRMaXN0ZW5lcih0eXBlLCBmLCBmYWxzZSk7XG4gICAgZWxzZSBpZiAoZW1pdHRlci5hdHRhY2hFdmVudClcbiAgICAgIGVtaXR0ZXIuYXR0YWNoRXZlbnQoXCJvblwiICsgdHlwZSwgZik7XG4gICAgZWxzZSB7XG4gICAgICB2YXIgbWFwID0gZW1pdHRlci5faGFuZGxlcnMgfHwgKGVtaXR0ZXIuX2hhbmRsZXJzID0ge30pO1xuICAgICAgdmFyIGFyciA9IG1hcFt0eXBlXSB8fCAobWFwW3R5cGVdID0gW10pO1xuICAgICAgYXJyLnB1c2goZik7XG4gICAgfVxuICB9O1xuXG4gIHZhciBvZmYgPSBDb2RlTWlycm9yLm9mZiA9IGZ1bmN0aW9uKGVtaXR0ZXIsIHR5cGUsIGYpIHtcbiAgICBpZiAoZW1pdHRlci5yZW1vdmVFdmVudExpc3RlbmVyKVxuICAgICAgZW1pdHRlci5yZW1vdmVFdmVudExpc3RlbmVyKHR5cGUsIGYsIGZhbHNlKTtcbiAgICBlbHNlIGlmIChlbWl0dGVyLmRldGFjaEV2ZW50KVxuICAgICAgZW1pdHRlci5kZXRhY2hFdmVudChcIm9uXCIgKyB0eXBlLCBmKTtcbiAgICBlbHNlIHtcbiAgICAgIHZhciBhcnIgPSBlbWl0dGVyLl9oYW5kbGVycyAmJiBlbWl0dGVyLl9oYW5kbGVyc1t0eXBlXTtcbiAgICAgIGlmICghYXJyKSByZXR1cm47XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGFyci5sZW5ndGg7ICsraSlcbiAgICAgICAgaWYgKGFycltpXSA9PSBmKSB7IGFyci5zcGxpY2UoaSwgMSk7IGJyZWFrOyB9XG4gICAgfVxuICB9O1xuXG4gIHZhciBzaWduYWwgPSBDb2RlTWlycm9yLnNpZ25hbCA9IGZ1bmN0aW9uKGVtaXR0ZXIsIHR5cGUgLyosIHZhbHVlcy4uLiovKSB7XG4gICAgdmFyIGFyciA9IGVtaXR0ZXIuX2hhbmRsZXJzICYmIGVtaXR0ZXIuX2hhbmRsZXJzW3R5cGVdO1xuICAgIGlmICghYXJyKSByZXR1cm47XG4gICAgdmFyIGFyZ3MgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMsIDIpO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYXJyLmxlbmd0aDsgKytpKSBhcnJbaV0uYXBwbHkobnVsbCwgYXJncyk7XG4gIH07XG5cbiAgdmFyIG9ycGhhbkRlbGF5ZWRDYWxsYmFja3MgPSBudWxsO1xuXG4gIC8vIE9mdGVuLCB3ZSB3YW50IHRvIHNpZ25hbCBldmVudHMgYXQgYSBwb2ludCB3aGVyZSB3ZSBhcmUgaW4gdGhlXG4gIC8vIG1pZGRsZSBvZiBzb21lIHdvcmssIGJ1dCBkb24ndCB3YW50IHRoZSBoYW5kbGVyIHRvIHN0YXJ0IGNhbGxpbmdcbiAgLy8gb3RoZXIgbWV0aG9kcyBvbiB0aGUgZWRpdG9yLCB3aGljaCBtaWdodCBiZSBpbiBhbiBpbmNvbnNpc3RlbnRcbiAgLy8gc3RhdGUgb3Igc2ltcGx5IG5vdCBleHBlY3QgYW55IG90aGVyIGV2ZW50cyB0byBoYXBwZW4uXG4gIC8vIHNpZ25hbExhdGVyIGxvb2tzIHdoZXRoZXIgdGhlcmUgYXJlIGFueSBoYW5kbGVycywgYW5kIHNjaGVkdWxlc1xuICAvLyB0aGVtIHRvIGJlIGV4ZWN1dGVkIHdoZW4gdGhlIGxhc3Qgb3BlcmF0aW9uIGVuZHMsIG9yLCBpZiBub1xuICAvLyBvcGVyYXRpb24gaXMgYWN0aXZlLCB3aGVuIGEgdGltZW91dCBmaXJlcy5cbiAgZnVuY3Rpb24gc2lnbmFsTGF0ZXIoZW1pdHRlciwgdHlwZSAvKiwgdmFsdWVzLi4uKi8pIHtcbiAgICB2YXIgYXJyID0gZW1pdHRlci5faGFuZGxlcnMgJiYgZW1pdHRlci5faGFuZGxlcnNbdHlwZV07XG4gICAgaWYgKCFhcnIpIHJldHVybjtcbiAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMiksIGxpc3Q7XG4gICAgaWYgKG9wZXJhdGlvbkdyb3VwKSB7XG4gICAgICBsaXN0ID0gb3BlcmF0aW9uR3JvdXAuZGVsYXllZENhbGxiYWNrcztcbiAgICB9IGVsc2UgaWYgKG9ycGhhbkRlbGF5ZWRDYWxsYmFja3MpIHtcbiAgICAgIGxpc3QgPSBvcnBoYW5EZWxheWVkQ2FsbGJhY2tzO1xuICAgIH0gZWxzZSB7XG4gICAgICBsaXN0ID0gb3JwaGFuRGVsYXllZENhbGxiYWNrcyA9IFtdO1xuICAgICAgc2V0VGltZW91dChmaXJlT3JwaGFuRGVsYXllZCwgMCk7XG4gICAgfVxuICAgIGZ1bmN0aW9uIGJuZChmKSB7cmV0dXJuIGZ1bmN0aW9uKCl7Zi5hcHBseShudWxsLCBhcmdzKTt9O307XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBhcnIubGVuZ3RoOyArK2kpXG4gICAgICBsaXN0LnB1c2goYm5kKGFycltpXSkpO1xuICB9XG5cbiAgZnVuY3Rpb24gZmlyZU9ycGhhbkRlbGF5ZWQoKSB7XG4gICAgdmFyIGRlbGF5ZWQgPSBvcnBoYW5EZWxheWVkQ2FsbGJhY2tzO1xuICAgIG9ycGhhbkRlbGF5ZWRDYWxsYmFja3MgPSBudWxsO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZGVsYXllZC5sZW5ndGg7ICsraSkgZGVsYXllZFtpXSgpO1xuICB9XG5cbiAgLy8gVGhlIERPTSBldmVudHMgdGhhdCBDb2RlTWlycm9yIGhhbmRsZXMgY2FuIGJlIG92ZXJyaWRkZW4gYnlcbiAgLy8gcmVnaXN0ZXJpbmcgYSAobm9uLURPTSkgaGFuZGxlciBvbiB0aGUgZWRpdG9yIGZvciB0aGUgZXZlbnQgbmFtZSxcbiAgLy8gYW5kIHByZXZlbnREZWZhdWx0LWluZyB0aGUgZXZlbnQgaW4gdGhhdCBoYW5kbGVyLlxuICBmdW5jdGlvbiBzaWduYWxET01FdmVudChjbSwgZSwgb3ZlcnJpZGUpIHtcbiAgICBzaWduYWwoY20sIG92ZXJyaWRlIHx8IGUudHlwZSwgY20sIGUpO1xuICAgIHJldHVybiBlX2RlZmF1bHRQcmV2ZW50ZWQoZSkgfHwgZS5jb2RlbWlycm9ySWdub3JlO1xuICB9XG5cbiAgZnVuY3Rpb24gc2lnbmFsQ3Vyc29yQWN0aXZpdHkoY20pIHtcbiAgICB2YXIgYXJyID0gY20uX2hhbmRsZXJzICYmIGNtLl9oYW5kbGVycy5jdXJzb3JBY3Rpdml0eTtcbiAgICBpZiAoIWFycikgcmV0dXJuO1xuICAgIHZhciBzZXQgPSBjbS5jdXJPcC5jdXJzb3JBY3Rpdml0eUhhbmRsZXJzIHx8IChjbS5jdXJPcC5jdXJzb3JBY3Rpdml0eUhhbmRsZXJzID0gW10pO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYXJyLmxlbmd0aDsgKytpKSBpZiAoaW5kZXhPZihzZXQsIGFycltpXSkgPT0gLTEpXG4gICAgICBzZXQucHVzaChhcnJbaV0pO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFzSGFuZGxlcihlbWl0dGVyLCB0eXBlKSB7XG4gICAgdmFyIGFyciA9IGVtaXR0ZXIuX2hhbmRsZXJzICYmIGVtaXR0ZXIuX2hhbmRsZXJzW3R5cGVdO1xuICAgIHJldHVybiBhcnIgJiYgYXJyLmxlbmd0aCA+IDA7XG4gIH1cblxuICAvLyBBZGQgb24gYW5kIG9mZiBtZXRob2RzIHRvIGEgY29uc3RydWN0b3IncyBwcm90b3R5cGUsIHRvIG1ha2VcbiAgLy8gcmVnaXN0ZXJpbmcgZXZlbnRzIG9uIHN1Y2ggb2JqZWN0cyBtb3JlIGNvbnZlbmllbnQuXG4gIGZ1bmN0aW9uIGV2ZW50TWl4aW4oY3Rvcikge1xuICAgIGN0b3IucHJvdG90eXBlLm9uID0gZnVuY3Rpb24odHlwZSwgZikge29uKHRoaXMsIHR5cGUsIGYpO307XG4gICAgY3Rvci5wcm90b3R5cGUub2ZmID0gZnVuY3Rpb24odHlwZSwgZikge29mZih0aGlzLCB0eXBlLCBmKTt9O1xuICB9XG5cbiAgLy8gTUlTQyBVVElMSVRJRVNcblxuICAvLyBOdW1iZXIgb2YgcGl4ZWxzIGFkZGVkIHRvIHNjcm9sbGVyIGFuZCBzaXplciB0byBoaWRlIHNjcm9sbGJhclxuICB2YXIgc2Nyb2xsZXJDdXRPZmYgPSAzMDtcblxuICAvLyBSZXR1cm5lZCBvciB0aHJvd24gYnkgdmFyaW91cyBwcm90b2NvbHMgdG8gc2lnbmFsICdJJ20gbm90XG4gIC8vIGhhbmRsaW5nIHRoaXMnLlxuICB2YXIgUGFzcyA9IENvZGVNaXJyb3IuUGFzcyA9IHt0b1N0cmluZzogZnVuY3Rpb24oKXtyZXR1cm4gXCJDb2RlTWlycm9yLlBhc3NcIjt9fTtcblxuICAvLyBSZXVzZWQgb3B0aW9uIG9iamVjdHMgZm9yIHNldFNlbGVjdGlvbiAmIGZyaWVuZHNcbiAgdmFyIHNlbF9kb250U2Nyb2xsID0ge3Njcm9sbDogZmFsc2V9LCBzZWxfbW91c2UgPSB7b3JpZ2luOiBcIiptb3VzZVwifSwgc2VsX21vdmUgPSB7b3JpZ2luOiBcIittb3ZlXCJ9O1xuXG4gIGZ1bmN0aW9uIERlbGF5ZWQoKSB7dGhpcy5pZCA9IG51bGw7fVxuICBEZWxheWVkLnByb3RvdHlwZS5zZXQgPSBmdW5jdGlvbihtcywgZikge1xuICAgIGNsZWFyVGltZW91dCh0aGlzLmlkKTtcbiAgICB0aGlzLmlkID0gc2V0VGltZW91dChmLCBtcyk7XG4gIH07XG5cbiAgLy8gQ291bnRzIHRoZSBjb2x1bW4gb2Zmc2V0IGluIGEgc3RyaW5nLCB0YWtpbmcgdGFicyBpbnRvIGFjY291bnQuXG4gIC8vIFVzZWQgbW9zdGx5IHRvIGZpbmQgaW5kZW50YXRpb24uXG4gIHZhciBjb3VudENvbHVtbiA9IENvZGVNaXJyb3IuY291bnRDb2x1bW4gPSBmdW5jdGlvbihzdHJpbmcsIGVuZCwgdGFiU2l6ZSwgc3RhcnRJbmRleCwgc3RhcnRWYWx1ZSkge1xuICAgIGlmIChlbmQgPT0gbnVsbCkge1xuICAgICAgZW5kID0gc3RyaW5nLnNlYXJjaCgvW15cXHNcXHUwMGEwXS8pO1xuICAgICAgaWYgKGVuZCA9PSAtMSkgZW5kID0gc3RyaW5nLmxlbmd0aDtcbiAgICB9XG4gICAgZm9yICh2YXIgaSA9IHN0YXJ0SW5kZXggfHwgMCwgbiA9IHN0YXJ0VmFsdWUgfHwgMDs7KSB7XG4gICAgICB2YXIgbmV4dFRhYiA9IHN0cmluZy5pbmRleE9mKFwiXFx0XCIsIGkpO1xuICAgICAgaWYgKG5leHRUYWIgPCAwIHx8IG5leHRUYWIgPj0gZW5kKVxuICAgICAgICByZXR1cm4gbiArIChlbmQgLSBpKTtcbiAgICAgIG4gKz0gbmV4dFRhYiAtIGk7XG4gICAgICBuICs9IHRhYlNpemUgLSAobiAlIHRhYlNpemUpO1xuICAgICAgaSA9IG5leHRUYWIgKyAxO1xuICAgIH1cbiAgfTtcblxuICAvLyBUaGUgaW52ZXJzZSBvZiBjb3VudENvbHVtbiAtLSBmaW5kIHRoZSBvZmZzZXQgdGhhdCBjb3JyZXNwb25kcyB0b1xuICAvLyBhIHBhcnRpY3VsYXIgY29sdW1uLlxuICBmdW5jdGlvbiBmaW5kQ29sdW1uKHN0cmluZywgZ29hbCwgdGFiU2l6ZSkge1xuICAgIGZvciAodmFyIHBvcyA9IDAsIGNvbCA9IDA7Oykge1xuICAgICAgdmFyIG5leHRUYWIgPSBzdHJpbmcuaW5kZXhPZihcIlxcdFwiLCBwb3MpO1xuICAgICAgaWYgKG5leHRUYWIgPT0gLTEpIG5leHRUYWIgPSBzdHJpbmcubGVuZ3RoO1xuICAgICAgdmFyIHNraXBwZWQgPSBuZXh0VGFiIC0gcG9zO1xuICAgICAgaWYgKG5leHRUYWIgPT0gc3RyaW5nLmxlbmd0aCB8fCBjb2wgKyBza2lwcGVkID49IGdvYWwpXG4gICAgICAgIHJldHVybiBwb3MgKyBNYXRoLm1pbihza2lwcGVkLCBnb2FsIC0gY29sKTtcbiAgICAgIGNvbCArPSBuZXh0VGFiIC0gcG9zO1xuICAgICAgY29sICs9IHRhYlNpemUgLSAoY29sICUgdGFiU2l6ZSk7XG4gICAgICBwb3MgPSBuZXh0VGFiICsgMTtcbiAgICAgIGlmIChjb2wgPj0gZ29hbCkgcmV0dXJuIHBvcztcbiAgICB9XG4gIH1cblxuICB2YXIgc3BhY2VTdHJzID0gW1wiXCJdO1xuICBmdW5jdGlvbiBzcGFjZVN0cihuKSB7XG4gICAgd2hpbGUgKHNwYWNlU3Rycy5sZW5ndGggPD0gbilcbiAgICAgIHNwYWNlU3Rycy5wdXNoKGxzdChzcGFjZVN0cnMpICsgXCIgXCIpO1xuICAgIHJldHVybiBzcGFjZVN0cnNbbl07XG4gIH1cblxuICBmdW5jdGlvbiBsc3QoYXJyKSB7IHJldHVybiBhcnJbYXJyLmxlbmd0aC0xXTsgfVxuXG4gIHZhciBzZWxlY3RJbnB1dCA9IGZ1bmN0aW9uKG5vZGUpIHsgbm9kZS5zZWxlY3QoKTsgfTtcbiAgaWYgKGlvcykgLy8gTW9iaWxlIFNhZmFyaSBhcHBhcmVudGx5IGhhcyBhIGJ1ZyB3aGVyZSBzZWxlY3QoKSBpcyBicm9rZW4uXG4gICAgc2VsZWN0SW5wdXQgPSBmdW5jdGlvbihub2RlKSB7IG5vZGUuc2VsZWN0aW9uU3RhcnQgPSAwOyBub2RlLnNlbGVjdGlvbkVuZCA9IG5vZGUudmFsdWUubGVuZ3RoOyB9O1xuICBlbHNlIGlmIChpZSkgLy8gU3VwcHJlc3MgbXlzdGVyaW91cyBJRTEwIGVycm9yc1xuICAgIHNlbGVjdElucHV0ID0gZnVuY3Rpb24obm9kZSkgeyB0cnkgeyBub2RlLnNlbGVjdCgpOyB9IGNhdGNoKF9lKSB7fSB9O1xuXG4gIGZ1bmN0aW9uIGluZGV4T2YoYXJyYXksIGVsdCkge1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYXJyYXkubGVuZ3RoOyArK2kpXG4gICAgICBpZiAoYXJyYXlbaV0gPT0gZWx0KSByZXR1cm4gaTtcbiAgICByZXR1cm4gLTE7XG4gIH1cbiAgaWYgKFtdLmluZGV4T2YpIGluZGV4T2YgPSBmdW5jdGlvbihhcnJheSwgZWx0KSB7IHJldHVybiBhcnJheS5pbmRleE9mKGVsdCk7IH07XG4gIGZ1bmN0aW9uIG1hcChhcnJheSwgZikge1xuICAgIHZhciBvdXQgPSBbXTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGFycmF5Lmxlbmd0aDsgaSsrKSBvdXRbaV0gPSBmKGFycmF5W2ldLCBpKTtcbiAgICByZXR1cm4gb3V0O1xuICB9XG4gIGlmIChbXS5tYXApIG1hcCA9IGZ1bmN0aW9uKGFycmF5LCBmKSB7IHJldHVybiBhcnJheS5tYXAoZik7IH07XG5cbiAgZnVuY3Rpb24gY3JlYXRlT2JqKGJhc2UsIHByb3BzKSB7XG4gICAgdmFyIGluc3Q7XG4gICAgaWYgKE9iamVjdC5jcmVhdGUpIHtcbiAgICAgIGluc3QgPSBPYmplY3QuY3JlYXRlKGJhc2UpO1xuICAgIH0gZWxzZSB7XG4gICAgICB2YXIgY3RvciA9IGZ1bmN0aW9uKCkge307XG4gICAgICBjdG9yLnByb3RvdHlwZSA9IGJhc2U7XG4gICAgICBpbnN0ID0gbmV3IGN0b3IoKTtcbiAgICB9XG4gICAgaWYgKHByb3BzKSBjb3B5T2JqKHByb3BzLCBpbnN0KTtcbiAgICByZXR1cm4gaW5zdDtcbiAgfTtcblxuICBmdW5jdGlvbiBjb3B5T2JqKG9iaiwgdGFyZ2V0LCBvdmVyd3JpdGUpIHtcbiAgICBpZiAoIXRhcmdldCkgdGFyZ2V0ID0ge307XG4gICAgZm9yICh2YXIgcHJvcCBpbiBvYmopXG4gICAgICBpZiAob2JqLmhhc093blByb3BlcnR5KHByb3ApICYmIChvdmVyd3JpdGUgIT09IGZhbHNlIHx8ICF0YXJnZXQuaGFzT3duUHJvcGVydHkocHJvcCkpKVxuICAgICAgICB0YXJnZXRbcHJvcF0gPSBvYmpbcHJvcF07XG4gICAgcmV0dXJuIHRhcmdldDtcbiAgfVxuXG4gIGZ1bmN0aW9uIGJpbmQoZikge1xuICAgIHZhciBhcmdzID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKTtcbiAgICByZXR1cm4gZnVuY3Rpb24oKXtyZXR1cm4gZi5hcHBseShudWxsLCBhcmdzKTt9O1xuICB9XG5cbiAgdmFyIG5vbkFTQ0lJU2luZ2xlQ2FzZVdvcmRDaGFyID0gL1tcXHUwMGRmXFx1MzA0MC1cXHUzMDlmXFx1MzBhMC1cXHUzMGZmXFx1MzQwMC1cXHU0ZGI1XFx1NGUwMC1cXHU5ZmNjXFx1YWMwMC1cXHVkN2FmXS87XG4gIHZhciBpc1dvcmRDaGFyQmFzaWMgPSBDb2RlTWlycm9yLmlzV29yZENoYXIgPSBmdW5jdGlvbihjaCkge1xuICAgIHJldHVybiAvXFx3Ly50ZXN0KGNoKSB8fCBjaCA+IFwiXFx4ODBcIiAmJlxuICAgICAgKGNoLnRvVXBwZXJDYXNlKCkgIT0gY2gudG9Mb3dlckNhc2UoKSB8fCBub25BU0NJSVNpbmdsZUNhc2VXb3JkQ2hhci50ZXN0KGNoKSk7XG4gIH07XG4gIGZ1bmN0aW9uIGlzV29yZENoYXIoY2gsIGhlbHBlcikge1xuICAgIGlmICghaGVscGVyKSByZXR1cm4gaXNXb3JkQ2hhckJhc2ljKGNoKTtcbiAgICBpZiAoaGVscGVyLnNvdXJjZS5pbmRleE9mKFwiXFxcXHdcIikgPiAtMSAmJiBpc1dvcmRDaGFyQmFzaWMoY2gpKSByZXR1cm4gdHJ1ZTtcbiAgICByZXR1cm4gaGVscGVyLnRlc3QoY2gpO1xuICB9XG5cbiAgZnVuY3Rpb24gaXNFbXB0eShvYmopIHtcbiAgICBmb3IgKHZhciBuIGluIG9iaikgaWYgKG9iai5oYXNPd25Qcm9wZXJ0eShuKSAmJiBvYmpbbl0pIHJldHVybiBmYWxzZTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIC8vIEV4dGVuZGluZyB1bmljb2RlIGNoYXJhY3RlcnMuIEEgc2VyaWVzIG9mIGEgbm9uLWV4dGVuZGluZyBjaGFyICtcbiAgLy8gYW55IG51bWJlciBvZiBleHRlbmRpbmcgY2hhcnMgaXMgdHJlYXRlZCBhcyBhIHNpbmdsZSB1bml0IGFzIGZhclxuICAvLyBhcyBlZGl0aW5nIGFuZCBtZWFzdXJpbmcgaXMgY29uY2VybmVkLiBUaGlzIGlzIG5vdCBmdWxseSBjb3JyZWN0LFxuICAvLyBzaW5jZSBzb21lIHNjcmlwdHMvZm9udHMvYnJvd3NlcnMgYWxzbyB0cmVhdCBvdGhlciBjb25maWd1cmF0aW9uc1xuICAvLyBvZiBjb2RlIHBvaW50cyBhcyBhIGdyb3VwLlxuICB2YXIgZXh0ZW5kaW5nQ2hhcnMgPSAvW1xcdTAzMDAtXFx1MDM2ZlxcdTA0ODMtXFx1MDQ4OVxcdTA1OTEtXFx1MDViZFxcdTA1YmZcXHUwNWMxXFx1MDVjMlxcdTA1YzRcXHUwNWM1XFx1MDVjN1xcdTA2MTAtXFx1MDYxYVxcdTA2NGItXFx1MDY1ZVxcdTA2NzBcXHUwNmQ2LVxcdTA2ZGNcXHUwNmRlLVxcdTA2ZTRcXHUwNmU3XFx1MDZlOFxcdTA2ZWEtXFx1MDZlZFxcdTA3MTFcXHUwNzMwLVxcdTA3NGFcXHUwN2E2LVxcdTA3YjBcXHUwN2ViLVxcdTA3ZjNcXHUwODE2LVxcdTA4MTlcXHUwODFiLVxcdTA4MjNcXHUwODI1LVxcdTA4MjdcXHUwODI5LVxcdTA4MmRcXHUwOTAwLVxcdTA5MDJcXHUwOTNjXFx1MDk0MS1cXHUwOTQ4XFx1MDk0ZFxcdTA5NTEtXFx1MDk1NVxcdTA5NjJcXHUwOTYzXFx1MDk4MVxcdTA5YmNcXHUwOWJlXFx1MDljMS1cXHUwOWM0XFx1MDljZFxcdTA5ZDdcXHUwOWUyXFx1MDllM1xcdTBhMDFcXHUwYTAyXFx1MGEzY1xcdTBhNDFcXHUwYTQyXFx1MGE0N1xcdTBhNDhcXHUwYTRiLVxcdTBhNGRcXHUwYTUxXFx1MGE3MFxcdTBhNzFcXHUwYTc1XFx1MGE4MVxcdTBhODJcXHUwYWJjXFx1MGFjMS1cXHUwYWM1XFx1MGFjN1xcdTBhYzhcXHUwYWNkXFx1MGFlMlxcdTBhZTNcXHUwYjAxXFx1MGIzY1xcdTBiM2VcXHUwYjNmXFx1MGI0MS1cXHUwYjQ0XFx1MGI0ZFxcdTBiNTZcXHUwYjU3XFx1MGI2MlxcdTBiNjNcXHUwYjgyXFx1MGJiZVxcdTBiYzBcXHUwYmNkXFx1MGJkN1xcdTBjM2UtXFx1MGM0MFxcdTBjNDYtXFx1MGM0OFxcdTBjNGEtXFx1MGM0ZFxcdTBjNTVcXHUwYzU2XFx1MGM2MlxcdTBjNjNcXHUwY2JjXFx1MGNiZlxcdTBjYzJcXHUwY2M2XFx1MGNjY1xcdTBjY2RcXHUwY2Q1XFx1MGNkNlxcdTBjZTJcXHUwY2UzXFx1MGQzZVxcdTBkNDEtXFx1MGQ0NFxcdTBkNGRcXHUwZDU3XFx1MGQ2MlxcdTBkNjNcXHUwZGNhXFx1MGRjZlxcdTBkZDItXFx1MGRkNFxcdTBkZDZcXHUwZGRmXFx1MGUzMVxcdTBlMzQtXFx1MGUzYVxcdTBlNDctXFx1MGU0ZVxcdTBlYjFcXHUwZWI0LVxcdTBlYjlcXHUwZWJiXFx1MGViY1xcdTBlYzgtXFx1MGVjZFxcdTBmMThcXHUwZjE5XFx1MGYzNVxcdTBmMzdcXHUwZjM5XFx1MGY3MS1cXHUwZjdlXFx1MGY4MC1cXHUwZjg0XFx1MGY4NlxcdTBmODdcXHUwZjkwLVxcdTBmOTdcXHUwZjk5LVxcdTBmYmNcXHUwZmM2XFx1MTAyZC1cXHUxMDMwXFx1MTAzMi1cXHUxMDM3XFx1MTAzOVxcdTEwM2FcXHUxMDNkXFx1MTAzZVxcdTEwNThcXHUxMDU5XFx1MTA1ZS1cXHUxMDYwXFx1MTA3MS1cXHUxMDc0XFx1MTA4MlxcdTEwODVcXHUxMDg2XFx1MTA4ZFxcdTEwOWRcXHUxMzVmXFx1MTcxMi1cXHUxNzE0XFx1MTczMi1cXHUxNzM0XFx1MTc1MlxcdTE3NTNcXHUxNzcyXFx1MTc3M1xcdTE3YjctXFx1MTdiZFxcdTE3YzZcXHUxN2M5LVxcdTE3ZDNcXHUxN2RkXFx1MTgwYi1cXHUxODBkXFx1MThhOVxcdTE5MjAtXFx1MTkyMlxcdTE5MjdcXHUxOTI4XFx1MTkzMlxcdTE5MzktXFx1MTkzYlxcdTFhMTdcXHUxYTE4XFx1MWE1NlxcdTFhNTgtXFx1MWE1ZVxcdTFhNjBcXHUxYTYyXFx1MWE2NS1cXHUxYTZjXFx1MWE3My1cXHUxYTdjXFx1MWE3ZlxcdTFiMDAtXFx1MWIwM1xcdTFiMzRcXHUxYjM2LVxcdTFiM2FcXHUxYjNjXFx1MWI0MlxcdTFiNmItXFx1MWI3M1xcdTFiODBcXHUxYjgxXFx1MWJhMi1cXHUxYmE1XFx1MWJhOFxcdTFiYTlcXHUxYzJjLVxcdTFjMzNcXHUxYzM2XFx1MWMzN1xcdTFjZDAtXFx1MWNkMlxcdTFjZDQtXFx1MWNlMFxcdTFjZTItXFx1MWNlOFxcdTFjZWRcXHUxZGMwLVxcdTFkZTZcXHUxZGZkLVxcdTFkZmZcXHUyMDBjXFx1MjAwZFxcdTIwZDAtXFx1MjBmMFxcdTJjZWYtXFx1MmNmMVxcdTJkZTAtXFx1MmRmZlxcdTMwMmEtXFx1MzAyZlxcdTMwOTlcXHUzMDlhXFx1YTY2Zi1cXHVhNjcyXFx1YTY3Y1xcdWE2N2RcXHVhNmYwXFx1YTZmMVxcdWE4MDJcXHVhODA2XFx1YTgwYlxcdWE4MjVcXHVhODI2XFx1YThjNFxcdWE4ZTAtXFx1YThmMVxcdWE5MjYtXFx1YTkyZFxcdWE5NDctXFx1YTk1MVxcdWE5ODAtXFx1YTk4MlxcdWE5YjNcXHVhOWI2LVxcdWE5YjlcXHVhOWJjXFx1YWEyOS1cXHVhYTJlXFx1YWEzMVxcdWFhMzJcXHVhYTM1XFx1YWEzNlxcdWFhNDNcXHVhYTRjXFx1YWFiMFxcdWFhYjItXFx1YWFiNFxcdWFhYjdcXHVhYWI4XFx1YWFiZVxcdWFhYmZcXHVhYWMxXFx1YWJlNVxcdWFiZThcXHVhYmVkXFx1ZGMwMC1cXHVkZmZmXFx1ZmIxZVxcdWZlMDAtXFx1ZmUwZlxcdWZlMjAtXFx1ZmUyNlxcdWZmOWVcXHVmZjlmXS87XG4gIGZ1bmN0aW9uIGlzRXh0ZW5kaW5nQ2hhcihjaCkgeyByZXR1cm4gY2guY2hhckNvZGVBdCgwKSA+PSA3NjggJiYgZXh0ZW5kaW5nQ2hhcnMudGVzdChjaCk7IH1cblxuICAvLyBET00gVVRJTElUSUVTXG5cbiAgZnVuY3Rpb24gZWx0KHRhZywgY29udGVudCwgY2xhc3NOYW1lLCBzdHlsZSkge1xuICAgIHZhciBlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCh0YWcpO1xuICAgIGlmIChjbGFzc05hbWUpIGUuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICAgIGlmIChzdHlsZSkgZS5zdHlsZS5jc3NUZXh0ID0gc3R5bGU7XG4gICAgaWYgKHR5cGVvZiBjb250ZW50ID09IFwic3RyaW5nXCIpIGUuYXBwZW5kQ2hpbGQoZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUoY29udGVudCkpO1xuICAgIGVsc2UgaWYgKGNvbnRlbnQpIGZvciAodmFyIGkgPSAwOyBpIDwgY29udGVudC5sZW5ndGg7ICsraSkgZS5hcHBlbmRDaGlsZChjb250ZW50W2ldKTtcbiAgICByZXR1cm4gZTtcbiAgfVxuXG4gIHZhciByYW5nZTtcbiAgaWYgKGRvY3VtZW50LmNyZWF0ZVJhbmdlKSByYW5nZSA9IGZ1bmN0aW9uKG5vZGUsIHN0YXJ0LCBlbmQpIHtcbiAgICB2YXIgciA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7XG4gICAgci5zZXRFbmQobm9kZSwgZW5kKTtcbiAgICByLnNldFN0YXJ0KG5vZGUsIHN0YXJ0KTtcbiAgICByZXR1cm4gcjtcbiAgfTtcbiAgZWxzZSByYW5nZSA9IGZ1bmN0aW9uKG5vZGUsIHN0YXJ0LCBlbmQpIHtcbiAgICB2YXIgciA9IGRvY3VtZW50LmJvZHkuY3JlYXRlVGV4dFJhbmdlKCk7XG4gICAgci5tb3ZlVG9FbGVtZW50VGV4dChub2RlLnBhcmVudE5vZGUpO1xuICAgIHIuY29sbGFwc2UodHJ1ZSk7XG4gICAgci5tb3ZlRW5kKFwiY2hhcmFjdGVyXCIsIGVuZCk7XG4gICAgci5tb3ZlU3RhcnQoXCJjaGFyYWN0ZXJcIiwgc3RhcnQpO1xuICAgIHJldHVybiByO1xuICB9O1xuXG4gIGZ1bmN0aW9uIHJlbW92ZUNoaWxkcmVuKGUpIHtcbiAgICBmb3IgKHZhciBjb3VudCA9IGUuY2hpbGROb2Rlcy5sZW5ndGg7IGNvdW50ID4gMDsgLS1jb3VudClcbiAgICAgIGUucmVtb3ZlQ2hpbGQoZS5maXJzdENoaWxkKTtcbiAgICByZXR1cm4gZTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHJlbW92ZUNoaWxkcmVuQW5kQWRkKHBhcmVudCwgZSkge1xuICAgIHJldHVybiByZW1vdmVDaGlsZHJlbihwYXJlbnQpLmFwcGVuZENoaWxkKGUpO1xuICB9XG5cbiAgZnVuY3Rpb24gY29udGFpbnMocGFyZW50LCBjaGlsZCkge1xuICAgIGlmIChwYXJlbnQuY29udGFpbnMpXG4gICAgICByZXR1cm4gcGFyZW50LmNvbnRhaW5zKGNoaWxkKTtcbiAgICB3aGlsZSAoY2hpbGQgPSBjaGlsZC5wYXJlbnROb2RlKVxuICAgICAgaWYgKGNoaWxkID09IHBhcmVudCkgcmV0dXJuIHRydWU7XG4gIH1cblxuICBmdW5jdGlvbiBhY3RpdmVFbHQoKSB7IHJldHVybiBkb2N1bWVudC5hY3RpdmVFbGVtZW50OyB9XG4gIC8vIE9sZGVyIHZlcnNpb25zIG9mIElFIHRocm93cyB1bnNwZWNpZmllZCBlcnJvciB3aGVuIHRvdWNoaW5nXG4gIC8vIGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgaW4gc29tZSBjYXNlcyAoZHVyaW5nIGxvYWRpbmcsIGluIGlmcmFtZSlcbiAgaWYgKGllICYmIGllX3ZlcnNpb24gPCAxMSkgYWN0aXZlRWx0ID0gZnVuY3Rpb24oKSB7XG4gICAgdHJ5IHsgcmV0dXJuIGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQ7IH1cbiAgICBjYXRjaChlKSB7IHJldHVybiBkb2N1bWVudC5ib2R5OyB9XG4gIH07XG5cbiAgZnVuY3Rpb24gY2xhc3NUZXN0KGNscykgeyByZXR1cm4gbmV3IFJlZ0V4cChcIlxcXFxiXCIgKyBjbHMgKyBcIlxcXFxiXFxcXHMqXCIpOyB9XG4gIGZ1bmN0aW9uIHJtQ2xhc3Mobm9kZSwgY2xzKSB7XG4gICAgdmFyIHRlc3QgPSBjbGFzc1Rlc3QoY2xzKTtcbiAgICBpZiAodGVzdC50ZXN0KG5vZGUuY2xhc3NOYW1lKSkgbm9kZS5jbGFzc05hbWUgPSBub2RlLmNsYXNzTmFtZS5yZXBsYWNlKHRlc3QsIFwiXCIpO1xuICB9XG4gIGZ1bmN0aW9uIGFkZENsYXNzKG5vZGUsIGNscykge1xuICAgIGlmICghY2xhc3NUZXN0KGNscykudGVzdChub2RlLmNsYXNzTmFtZSkpIG5vZGUuY2xhc3NOYW1lICs9IFwiIFwiICsgY2xzO1xuICB9XG4gIGZ1bmN0aW9uIGpvaW5DbGFzc2VzKGEsIGIpIHtcbiAgICB2YXIgYXMgPSBhLnNwbGl0KFwiIFwiKTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGFzLmxlbmd0aDsgaSsrKVxuICAgICAgaWYgKGFzW2ldICYmICFjbGFzc1Rlc3QoYXNbaV0pLnRlc3QoYikpIGIgKz0gXCIgXCIgKyBhc1tpXTtcbiAgICByZXR1cm4gYjtcbiAgfVxuXG4gIC8vIFdJTkRPVy1XSURFIEVWRU5UU1xuXG4gIC8vIFRoZXNlIG11c3QgYmUgaGFuZGxlZCBjYXJlZnVsbHksIGJlY2F1c2UgbmFpdmVseSByZWdpc3RlcmluZyBhXG4gIC8vIGhhbmRsZXIgZm9yIGVhY2ggZWRpdG9yIHdpbGwgY2F1c2UgdGhlIGVkaXRvcnMgdG8gbmV2ZXIgYmVcbiAgLy8gZ2FyYmFnZSBjb2xsZWN0ZWQuXG5cbiAgZnVuY3Rpb24gZm9yRWFjaENvZGVNaXJyb3IoZikge1xuICAgIGlmICghZG9jdW1lbnQuYm9keS5nZXRFbGVtZW50c0J5Q2xhc3NOYW1lKSByZXR1cm47XG4gICAgdmFyIGJ5Q2xhc3MgPSBkb2N1bWVudC5ib2R5LmdldEVsZW1lbnRzQnlDbGFzc05hbWUoXCJDb2RlTWlycm9yXCIpO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYnlDbGFzcy5sZW5ndGg7IGkrKykge1xuICAgICAgdmFyIGNtID0gYnlDbGFzc1tpXS5Db2RlTWlycm9yO1xuICAgICAgaWYgKGNtKSBmKGNtKTtcbiAgICB9XG4gIH1cblxuICB2YXIgZ2xvYmFsc1JlZ2lzdGVyZWQgPSBmYWxzZTtcbiAgZnVuY3Rpb24gZW5zdXJlR2xvYmFsSGFuZGxlcnMoKSB7XG4gICAgaWYgKGdsb2JhbHNSZWdpc3RlcmVkKSByZXR1cm47XG4gICAgcmVnaXN0ZXJHbG9iYWxIYW5kbGVycygpO1xuICAgIGdsb2JhbHNSZWdpc3RlcmVkID0gdHJ1ZTtcbiAgfVxuICBmdW5jdGlvbiByZWdpc3Rlckdsb2JhbEhhbmRsZXJzKCkge1xuICAgIC8vIFdoZW4gdGhlIHdpbmRvdyByZXNpemVzLCB3ZSBuZWVkIHRvIHJlZnJlc2ggYWN0aXZlIGVkaXRvcnMuXG4gICAgdmFyIHJlc2l6ZVRpbWVyO1xuICAgIG9uKHdpbmRvdywgXCJyZXNpemVcIiwgZnVuY3Rpb24oKSB7XG4gICAgICBpZiAocmVzaXplVGltZXIgPT0gbnVsbCkgcmVzaXplVGltZXIgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uKCkge1xuICAgICAgICByZXNpemVUaW1lciA9IG51bGw7XG4gICAgICAgIGtub3duU2Nyb2xsYmFyV2lkdGggPSBudWxsO1xuICAgICAgICBmb3JFYWNoQ29kZU1pcnJvcihvblJlc2l6ZSk7XG4gICAgICB9LCAxMDApO1xuICAgIH0pO1xuICAgIC8vIFdoZW4gdGhlIHdpbmRvdyBsb3NlcyBmb2N1cywgd2Ugd2FudCB0byBzaG93IHRoZSBlZGl0b3IgYXMgYmx1cnJlZFxuICAgIG9uKHdpbmRvdywgXCJibHVyXCIsIGZ1bmN0aW9uKCkge1xuICAgICAgZm9yRWFjaENvZGVNaXJyb3Iob25CbHVyKTtcbiAgICB9KTtcbiAgfVxuXG4gIC8vIEZFQVRVUkUgREVURUNUSU9OXG5cbiAgLy8gRGV0ZWN0IGRyYWctYW5kLWRyb3BcbiAgdmFyIGRyYWdBbmREcm9wID0gZnVuY3Rpb24oKSB7XG4gICAgLy8gVGhlcmUgaXMgKnNvbWUqIGtpbmQgb2YgZHJhZy1hbmQtZHJvcCBzdXBwb3J0IGluIElFNi04LCBidXQgSVxuICAgIC8vIGNvdWxkbid0IGdldCBpdCB0byB3b3JrIHlldC5cbiAgICBpZiAoaWUgJiYgaWVfdmVyc2lvbiA8IDkpIHJldHVybiBmYWxzZTtcbiAgICB2YXIgZGl2ID0gZWx0KCdkaXYnKTtcbiAgICByZXR1cm4gXCJkcmFnZ2FibGVcIiBpbiBkaXYgfHwgXCJkcmFnRHJvcFwiIGluIGRpdjtcbiAgfSgpO1xuXG4gIHZhciBrbm93blNjcm9sbGJhcldpZHRoO1xuICBmdW5jdGlvbiBzY3JvbGxiYXJXaWR0aChtZWFzdXJlKSB7XG4gICAgaWYgKGtub3duU2Nyb2xsYmFyV2lkdGggIT0gbnVsbCkgcmV0dXJuIGtub3duU2Nyb2xsYmFyV2lkdGg7XG4gICAgdmFyIHRlc3QgPSBlbHQoXCJkaXZcIiwgbnVsbCwgbnVsbCwgXCJ3aWR0aDogNTBweDsgaGVpZ2h0OiA1MHB4OyBvdmVyZmxvdy14OiBzY3JvbGxcIik7XG4gICAgcmVtb3ZlQ2hpbGRyZW5BbmRBZGQobWVhc3VyZSwgdGVzdCk7XG4gICAgaWYgKHRlc3Qub2Zmc2V0V2lkdGgpXG4gICAgICBrbm93blNjcm9sbGJhcldpZHRoID0gdGVzdC5vZmZzZXRIZWlnaHQgLSB0ZXN0LmNsaWVudEhlaWdodDtcbiAgICByZXR1cm4ga25vd25TY3JvbGxiYXJXaWR0aCB8fCAwO1xuICB9XG5cbiAgdmFyIHp3c3BTdXBwb3J0ZWQ7XG4gIGZ1bmN0aW9uIHplcm9XaWR0aEVsZW1lbnQobWVhc3VyZSkge1xuICAgIGlmICh6d3NwU3VwcG9ydGVkID09IG51bGwpIHtcbiAgICAgIHZhciB0ZXN0ID0gZWx0KFwic3BhblwiLCBcIlxcdTIwMGJcIik7XG4gICAgICByZW1vdmVDaGlsZHJlbkFuZEFkZChtZWFzdXJlLCBlbHQoXCJzcGFuXCIsIFt0ZXN0LCBkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZShcInhcIildKSk7XG4gICAgICBpZiAobWVhc3VyZS5maXJzdENoaWxkLm9mZnNldEhlaWdodCAhPSAwKVxuICAgICAgICB6d3NwU3VwcG9ydGVkID0gdGVzdC5vZmZzZXRXaWR0aCA8PSAxICYmIHRlc3Qub2Zmc2V0SGVpZ2h0ID4gMiAmJiAhKGllICYmIGllX3ZlcnNpb24gPCA4KTtcbiAgICB9XG4gICAgaWYgKHp3c3BTdXBwb3J0ZWQpIHJldHVybiBlbHQoXCJzcGFuXCIsIFwiXFx1MjAwYlwiKTtcbiAgICBlbHNlIHJldHVybiBlbHQoXCJzcGFuXCIsIFwiXFx1MDBhMFwiLCBudWxsLCBcImRpc3BsYXk6IGlubGluZS1ibG9jazsgd2lkdGg6IDFweDsgbWFyZ2luLXJpZ2h0OiAtMXB4XCIpO1xuICB9XG5cbiAgLy8gRmVhdHVyZS1kZXRlY3QgSUUncyBjcnVtbXkgY2xpZW50IHJlY3QgcmVwb3J0aW5nIGZvciBiaWRpIHRleHRcbiAgdmFyIGJhZEJpZGlSZWN0cztcbiAgZnVuY3Rpb24gaGFzQmFkQmlkaVJlY3RzKG1lYXN1cmUpIHtcbiAgICBpZiAoYmFkQmlkaVJlY3RzICE9IG51bGwpIHJldHVybiBiYWRCaWRpUmVjdHM7XG4gICAgdmFyIHR4dCA9IHJlbW92ZUNoaWxkcmVuQW5kQWRkKG1lYXN1cmUsIGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKFwiQVxcdTA2MmVBXCIpKTtcbiAgICB2YXIgcjAgPSByYW5nZSh0eHQsIDAsIDEpLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgIGlmIChyMC5sZWZ0ID09IHIwLnJpZ2h0KSByZXR1cm4gZmFsc2U7XG4gICAgdmFyIHIxID0gcmFuZ2UodHh0LCAxLCAyKS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICByZXR1cm4gYmFkQmlkaVJlY3RzID0gKHIxLnJpZ2h0IC0gcjAucmlnaHQgPCAzKTtcbiAgfVxuXG4gIC8vIFNlZSBpZiBcIlwiLnNwbGl0IGlzIHRoZSBicm9rZW4gSUUgdmVyc2lvbiwgaWYgc28sIHByb3ZpZGUgYW5cbiAgLy8gYWx0ZXJuYXRpdmUgd2F5IHRvIHNwbGl0IGxpbmVzLlxuICB2YXIgc3BsaXRMaW5lcyA9IENvZGVNaXJyb3Iuc3BsaXRMaW5lcyA9IFwiXFxuXFxuYlwiLnNwbGl0KC9cXG4vKS5sZW5ndGggIT0gMyA/IGZ1bmN0aW9uKHN0cmluZykge1xuICAgIHZhciBwb3MgPSAwLCByZXN1bHQgPSBbXSwgbCA9IHN0cmluZy5sZW5ndGg7XG4gICAgd2hpbGUgKHBvcyA8PSBsKSB7XG4gICAgICB2YXIgbmwgPSBzdHJpbmcuaW5kZXhPZihcIlxcblwiLCBwb3MpO1xuICAgICAgaWYgKG5sID09IC0xKSBubCA9IHN0cmluZy5sZW5ndGg7XG4gICAgICB2YXIgbGluZSA9IHN0cmluZy5zbGljZShwb3MsIHN0cmluZy5jaGFyQXQobmwgLSAxKSA9PSBcIlxcclwiID8gbmwgLSAxIDogbmwpO1xuICAgICAgdmFyIHJ0ID0gbGluZS5pbmRleE9mKFwiXFxyXCIpO1xuICAgICAgaWYgKHJ0ICE9IC0xKSB7XG4gICAgICAgIHJlc3VsdC5wdXNoKGxpbmUuc2xpY2UoMCwgcnQpKTtcbiAgICAgICAgcG9zICs9IHJ0ICsgMTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlc3VsdC5wdXNoKGxpbmUpO1xuICAgICAgICBwb3MgPSBubCArIDE7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiByZXN1bHQ7XG4gIH0gOiBmdW5jdGlvbihzdHJpbmcpe3JldHVybiBzdHJpbmcuc3BsaXQoL1xcclxcbj98XFxuLyk7fTtcblxuICB2YXIgaGFzU2VsZWN0aW9uID0gd2luZG93LmdldFNlbGVjdGlvbiA/IGZ1bmN0aW9uKHRlKSB7XG4gICAgdHJ5IHsgcmV0dXJuIHRlLnNlbGVjdGlvblN0YXJ0ICE9IHRlLnNlbGVjdGlvbkVuZDsgfVxuICAgIGNhdGNoKGUpIHsgcmV0dXJuIGZhbHNlOyB9XG4gIH0gOiBmdW5jdGlvbih0ZSkge1xuICAgIHRyeSB7dmFyIHJhbmdlID0gdGUub3duZXJEb2N1bWVudC5zZWxlY3Rpb24uY3JlYXRlUmFuZ2UoKTt9XG4gICAgY2F0Y2goZSkge31cbiAgICBpZiAoIXJhbmdlIHx8IHJhbmdlLnBhcmVudEVsZW1lbnQoKSAhPSB0ZSkgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiByYW5nZS5jb21wYXJlRW5kUG9pbnRzKFwiU3RhcnRUb0VuZFwiLCByYW5nZSkgIT0gMDtcbiAgfTtcblxuICB2YXIgaGFzQ29weUV2ZW50ID0gKGZ1bmN0aW9uKCkge1xuICAgIHZhciBlID0gZWx0KFwiZGl2XCIpO1xuICAgIGlmIChcIm9uY29weVwiIGluIGUpIHJldHVybiB0cnVlO1xuICAgIGUuc2V0QXR0cmlidXRlKFwib25jb3B5XCIsIFwicmV0dXJuO1wiKTtcbiAgICByZXR1cm4gdHlwZW9mIGUub25jb3B5ID09IFwiZnVuY3Rpb25cIjtcbiAgfSkoKTtcblxuICB2YXIgYmFkWm9vbWVkUmVjdHMgPSBudWxsO1xuICBmdW5jdGlvbiBoYXNCYWRab29tZWRSZWN0cyhtZWFzdXJlKSB7XG4gICAgaWYgKGJhZFpvb21lZFJlY3RzICE9IG51bGwpIHJldHVybiBiYWRab29tZWRSZWN0cztcbiAgICB2YXIgbm9kZSA9IHJlbW92ZUNoaWxkcmVuQW5kQWRkKG1lYXN1cmUsIGVsdChcInNwYW5cIiwgXCJ4XCIpKTtcbiAgICB2YXIgbm9ybWFsID0gbm9kZS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICB2YXIgZnJvbVJhbmdlID0gcmFuZ2Uobm9kZSwgMCwgMSkuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgcmV0dXJuIGJhZFpvb21lZFJlY3RzID0gTWF0aC5hYnMobm9ybWFsLmxlZnQgLSBmcm9tUmFuZ2UubGVmdCkgPiAxO1xuICB9XG5cbiAgLy8gS0VZIE5BTUVTXG5cbiAgdmFyIGtleU5hbWVzID0gezM6IFwiRW50ZXJcIiwgODogXCJCYWNrc3BhY2VcIiwgOTogXCJUYWJcIiwgMTM6IFwiRW50ZXJcIiwgMTY6IFwiU2hpZnRcIiwgMTc6IFwiQ3RybFwiLCAxODogXCJBbHRcIixcbiAgICAgICAgICAgICAgICAgIDE5OiBcIlBhdXNlXCIsIDIwOiBcIkNhcHNMb2NrXCIsIDI3OiBcIkVzY1wiLCAzMjogXCJTcGFjZVwiLCAzMzogXCJQYWdlVXBcIiwgMzQ6IFwiUGFnZURvd25cIiwgMzU6IFwiRW5kXCIsXG4gICAgICAgICAgICAgICAgICAzNjogXCJIb21lXCIsIDM3OiBcIkxlZnRcIiwgMzg6IFwiVXBcIiwgMzk6IFwiUmlnaHRcIiwgNDA6IFwiRG93blwiLCA0NDogXCJQcmludFNjcm5cIiwgNDU6IFwiSW5zZXJ0XCIsXG4gICAgICAgICAgICAgICAgICA0NjogXCJEZWxldGVcIiwgNTk6IFwiO1wiLCA2MTogXCI9XCIsIDkxOiBcIk1vZFwiLCA5MjogXCJNb2RcIiwgOTM6IFwiTW9kXCIsIDEwNzogXCI9XCIsIDEwOTogXCItXCIsIDEyNzogXCJEZWxldGVcIixcbiAgICAgICAgICAgICAgICAgIDE3MzogXCItXCIsIDE4NjogXCI7XCIsIDE4NzogXCI9XCIsIDE4ODogXCIsXCIsIDE4OTogXCItXCIsIDE5MDogXCIuXCIsIDE5MTogXCIvXCIsIDE5MjogXCJgXCIsIDIxOTogXCJbXCIsIDIyMDogXCJcXFxcXCIsXG4gICAgICAgICAgICAgICAgICAyMjE6IFwiXVwiLCAyMjI6IFwiJ1wiLCA2MzIzMjogXCJVcFwiLCA2MzIzMzogXCJEb3duXCIsIDYzMjM0OiBcIkxlZnRcIiwgNjMyMzU6IFwiUmlnaHRcIiwgNjMyNzI6IFwiRGVsZXRlXCIsXG4gICAgICAgICAgICAgICAgICA2MzI3MzogXCJIb21lXCIsIDYzMjc1OiBcIkVuZFwiLCA2MzI3NjogXCJQYWdlVXBcIiwgNjMyNzc6IFwiUGFnZURvd25cIiwgNjMzMDI6IFwiSW5zZXJ0XCJ9O1xuICBDb2RlTWlycm9yLmtleU5hbWVzID0ga2V5TmFtZXM7XG4gIChmdW5jdGlvbigpIHtcbiAgICAvLyBOdW1iZXIga2V5c1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgMTA7IGkrKykga2V5TmFtZXNbaSArIDQ4XSA9IGtleU5hbWVzW2kgKyA5Nl0gPSBTdHJpbmcoaSk7XG4gICAgLy8gQWxwaGFiZXRpYyBrZXlzXG4gICAgZm9yICh2YXIgaSA9IDY1OyBpIDw9IDkwOyBpKyspIGtleU5hbWVzW2ldID0gU3RyaW5nLmZyb21DaGFyQ29kZShpKTtcbiAgICAvLyBGdW5jdGlvbiBrZXlzXG4gICAgZm9yICh2YXIgaSA9IDE7IGkgPD0gMTI7IGkrKykga2V5TmFtZXNbaSArIDExMV0gPSBrZXlOYW1lc1tpICsgNjMyMzVdID0gXCJGXCIgKyBpO1xuICB9KSgpO1xuXG4gIC8vIEJJREkgSEVMUEVSU1xuXG4gIGZ1bmN0aW9uIGl0ZXJhdGVCaWRpU2VjdGlvbnMob3JkZXIsIGZyb20sIHRvLCBmKSB7XG4gICAgaWYgKCFvcmRlcikgcmV0dXJuIGYoZnJvbSwgdG8sIFwibHRyXCIpO1xuICAgIHZhciBmb3VuZCA9IGZhbHNlO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgb3JkZXIubGVuZ3RoOyArK2kpIHtcbiAgICAgIHZhciBwYXJ0ID0gb3JkZXJbaV07XG4gICAgICBpZiAocGFydC5mcm9tIDwgdG8gJiYgcGFydC50byA+IGZyb20gfHwgZnJvbSA9PSB0byAmJiBwYXJ0LnRvID09IGZyb20pIHtcbiAgICAgICAgZihNYXRoLm1heChwYXJ0LmZyb20sIGZyb20pLCBNYXRoLm1pbihwYXJ0LnRvLCB0byksIHBhcnQubGV2ZWwgPT0gMSA/IFwicnRsXCIgOiBcImx0clwiKTtcbiAgICAgICAgZm91bmQgPSB0cnVlO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoIWZvdW5kKSBmKGZyb20sIHRvLCBcImx0clwiKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGJpZGlMZWZ0KHBhcnQpIHsgcmV0dXJuIHBhcnQubGV2ZWwgJSAyID8gcGFydC50byA6IHBhcnQuZnJvbTsgfVxuICBmdW5jdGlvbiBiaWRpUmlnaHQocGFydCkgeyByZXR1cm4gcGFydC5sZXZlbCAlIDIgPyBwYXJ0LmZyb20gOiBwYXJ0LnRvOyB9XG5cbiAgZnVuY3Rpb24gbGluZUxlZnQobGluZSkgeyB2YXIgb3JkZXIgPSBnZXRPcmRlcihsaW5lKTsgcmV0dXJuIG9yZGVyID8gYmlkaUxlZnQob3JkZXJbMF0pIDogMDsgfVxuICBmdW5jdGlvbiBsaW5lUmlnaHQobGluZSkge1xuICAgIHZhciBvcmRlciA9IGdldE9yZGVyKGxpbmUpO1xuICAgIGlmICghb3JkZXIpIHJldHVybiBsaW5lLnRleHQubGVuZ3RoO1xuICAgIHJldHVybiBiaWRpUmlnaHQobHN0KG9yZGVyKSk7XG4gIH1cblxuICBmdW5jdGlvbiBsaW5lU3RhcnQoY20sIGxpbmVOKSB7XG4gICAgdmFyIGxpbmUgPSBnZXRMaW5lKGNtLmRvYywgbGluZU4pO1xuICAgIHZhciB2aXN1YWwgPSB2aXN1YWxMaW5lKGxpbmUpO1xuICAgIGlmICh2aXN1YWwgIT0gbGluZSkgbGluZU4gPSBsaW5lTm8odmlzdWFsKTtcbiAgICB2YXIgb3JkZXIgPSBnZXRPcmRlcih2aXN1YWwpO1xuICAgIHZhciBjaCA9ICFvcmRlciA/IDAgOiBvcmRlclswXS5sZXZlbCAlIDIgPyBsaW5lUmlnaHQodmlzdWFsKSA6IGxpbmVMZWZ0KHZpc3VhbCk7XG4gICAgcmV0dXJuIFBvcyhsaW5lTiwgY2gpO1xuICB9XG4gIGZ1bmN0aW9uIGxpbmVFbmQoY20sIGxpbmVOKSB7XG4gICAgdmFyIG1lcmdlZCwgbGluZSA9IGdldExpbmUoY20uZG9jLCBsaW5lTik7XG4gICAgd2hpbGUgKG1lcmdlZCA9IGNvbGxhcHNlZFNwYW5BdEVuZChsaW5lKSkge1xuICAgICAgbGluZSA9IG1lcmdlZC5maW5kKDEsIHRydWUpLmxpbmU7XG4gICAgICBsaW5lTiA9IG51bGw7XG4gICAgfVxuICAgIHZhciBvcmRlciA9IGdldE9yZGVyKGxpbmUpO1xuICAgIHZhciBjaCA9ICFvcmRlciA/IGxpbmUudGV4dC5sZW5ndGggOiBvcmRlclswXS5sZXZlbCAlIDIgPyBsaW5lTGVmdChsaW5lKSA6IGxpbmVSaWdodChsaW5lKTtcbiAgICByZXR1cm4gUG9zKGxpbmVOID09IG51bGwgPyBsaW5lTm8obGluZSkgOiBsaW5lTiwgY2gpO1xuICB9XG5cbiAgZnVuY3Rpb24gY29tcGFyZUJpZGlMZXZlbChvcmRlciwgYSwgYikge1xuICAgIHZhciBsaW5lZGlyID0gb3JkZXJbMF0ubGV2ZWw7XG4gICAgaWYgKGEgPT0gbGluZWRpcikgcmV0dXJuIHRydWU7XG4gICAgaWYgKGIgPT0gbGluZWRpcikgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiBhIDwgYjtcbiAgfVxuICB2YXIgYmlkaU90aGVyO1xuICBmdW5jdGlvbiBnZXRCaWRpUGFydEF0KG9yZGVyLCBwb3MpIHtcbiAgICBiaWRpT3RoZXIgPSBudWxsO1xuICAgIGZvciAodmFyIGkgPSAwLCBmb3VuZDsgaSA8IG9yZGVyLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YXIgY3VyID0gb3JkZXJbaV07XG4gICAgICBpZiAoY3VyLmZyb20gPCBwb3MgJiYgY3VyLnRvID4gcG9zKSByZXR1cm4gaTtcbiAgICAgIGlmICgoY3VyLmZyb20gPT0gcG9zIHx8IGN1ci50byA9PSBwb3MpKSB7XG4gICAgICAgIGlmIChmb3VuZCA9PSBudWxsKSB7XG4gICAgICAgICAgZm91bmQgPSBpO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbXBhcmVCaWRpTGV2ZWwob3JkZXIsIGN1ci5sZXZlbCwgb3JkZXJbZm91bmRdLmxldmVsKSkge1xuICAgICAgICAgIGlmIChjdXIuZnJvbSAhPSBjdXIudG8pIGJpZGlPdGhlciA9IGZvdW5kO1xuICAgICAgICAgIHJldHVybiBpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGlmIChjdXIuZnJvbSAhPSBjdXIudG8pIGJpZGlPdGhlciA9IGk7XG4gICAgICAgICAgcmV0dXJuIGZvdW5kO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBmb3VuZDtcbiAgfVxuXG4gIGZ1bmN0aW9uIG1vdmVJbkxpbmUobGluZSwgcG9zLCBkaXIsIGJ5VW5pdCkge1xuICAgIGlmICghYnlVbml0KSByZXR1cm4gcG9zICsgZGlyO1xuICAgIGRvIHBvcyArPSBkaXI7XG4gICAgd2hpbGUgKHBvcyA+IDAgJiYgaXNFeHRlbmRpbmdDaGFyKGxpbmUudGV4dC5jaGFyQXQocG9zKSkpO1xuICAgIHJldHVybiBwb3M7XG4gIH1cblxuICAvLyBUaGlzIGlzIG5lZWRlZCBpbiBvcmRlciB0byBtb3ZlICd2aXN1YWxseScgdGhyb3VnaCBiaS1kaXJlY3Rpb25hbFxuICAvLyB0ZXh0IC0tIGkuZS4sIHByZXNzaW5nIGxlZnQgc2hvdWxkIG1ha2UgdGhlIGN1cnNvciBnbyBsZWZ0LCBldmVuXG4gIC8vIHdoZW4gaW4gUlRMIHRleHQuIFRoZSB0cmlja3kgcGFydCBpcyB0aGUgJ2p1bXBzJywgd2hlcmUgUlRMIGFuZFxuICAvLyBMVFIgdGV4dCB0b3VjaCBlYWNoIG90aGVyLiBUaGlzIG9mdGVuIHJlcXVpcmVzIHRoZSBjdXJzb3Igb2Zmc2V0XG4gIC8vIHRvIG1vdmUgbW9yZSB0aGFuIG9uZSB1bml0LCBpbiBvcmRlciB0byB2aXN1YWxseSBtb3ZlIG9uZSB1bml0LlxuICBmdW5jdGlvbiBtb3ZlVmlzdWFsbHkobGluZSwgc3RhcnQsIGRpciwgYnlVbml0KSB7XG4gICAgdmFyIGJpZGkgPSBnZXRPcmRlcihsaW5lKTtcbiAgICBpZiAoIWJpZGkpIHJldHVybiBtb3ZlTG9naWNhbGx5KGxpbmUsIHN0YXJ0LCBkaXIsIGJ5VW5pdCk7XG4gICAgdmFyIHBvcyA9IGdldEJpZGlQYXJ0QXQoYmlkaSwgc3RhcnQpLCBwYXJ0ID0gYmlkaVtwb3NdO1xuICAgIHZhciB0YXJnZXQgPSBtb3ZlSW5MaW5lKGxpbmUsIHN0YXJ0LCBwYXJ0LmxldmVsICUgMiA/IC1kaXIgOiBkaXIsIGJ5VW5pdCk7XG5cbiAgICBmb3IgKDs7KSB7XG4gICAgICBpZiAodGFyZ2V0ID4gcGFydC5mcm9tICYmIHRhcmdldCA8IHBhcnQudG8pIHJldHVybiB0YXJnZXQ7XG4gICAgICBpZiAodGFyZ2V0ID09IHBhcnQuZnJvbSB8fCB0YXJnZXQgPT0gcGFydC50bykge1xuICAgICAgICBpZiAoZ2V0QmlkaVBhcnRBdChiaWRpLCB0YXJnZXQpID09IHBvcykgcmV0dXJuIHRhcmdldDtcbiAgICAgICAgcGFydCA9IGJpZGlbcG9zICs9IGRpcl07XG4gICAgICAgIHJldHVybiAoZGlyID4gMCkgPT0gcGFydC5sZXZlbCAlIDIgPyBwYXJ0LnRvIDogcGFydC5mcm9tO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcGFydCA9IGJpZGlbcG9zICs9IGRpcl07XG4gICAgICAgIGlmICghcGFydCkgcmV0dXJuIG51bGw7XG4gICAgICAgIGlmICgoZGlyID4gMCkgPT0gcGFydC5sZXZlbCAlIDIpXG4gICAgICAgICAgdGFyZ2V0ID0gbW92ZUluTGluZShsaW5lLCBwYXJ0LnRvLCAtMSwgYnlVbml0KTtcbiAgICAgICAgZWxzZVxuICAgICAgICAgIHRhcmdldCA9IG1vdmVJbkxpbmUobGluZSwgcGFydC5mcm9tLCAxLCBieVVuaXQpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIG1vdmVMb2dpY2FsbHkobGluZSwgc3RhcnQsIGRpciwgYnlVbml0KSB7XG4gICAgdmFyIHRhcmdldCA9IHN0YXJ0ICsgZGlyO1xuICAgIGlmIChieVVuaXQpIHdoaWxlICh0YXJnZXQgPiAwICYmIGlzRXh0ZW5kaW5nQ2hhcihsaW5lLnRleHQuY2hhckF0KHRhcmdldCkpKSB0YXJnZXQgKz0gZGlyO1xuICAgIHJldHVybiB0YXJnZXQgPCAwIHx8IHRhcmdldCA+IGxpbmUudGV4dC5sZW5ndGggPyBudWxsIDogdGFyZ2V0O1xuICB9XG5cbiAgLy8gQmlkaXJlY3Rpb25hbCBvcmRlcmluZyBhbGdvcml0aG1cbiAgLy8gU2VlIGh0dHA6Ly91bmljb2RlLm9yZy9yZXBvcnRzL3RyOS90cjktMTMuaHRtbCBmb3IgdGhlIGFsZ29yaXRobVxuICAvLyB0aGF0IHRoaXMgKHBhcnRpYWxseSkgaW1wbGVtZW50cy5cblxuICAvLyBPbmUtY2hhciBjb2RlcyB1c2VkIGZvciBjaGFyYWN0ZXIgdHlwZXM6XG4gIC8vIEwgKEwpOiAgIExlZnQtdG8tUmlnaHRcbiAgLy8gUiAoUik6ICAgUmlnaHQtdG8tTGVmdFxuICAvLyByIChBTCk6ICBSaWdodC10by1MZWZ0IEFyYWJpY1xuICAvLyAxIChFTik6ICBFdXJvcGVhbiBOdW1iZXJcbiAgLy8gKyAoRVMpOiAgRXVyb3BlYW4gTnVtYmVyIFNlcGFyYXRvclxuICAvLyAlIChFVCk6ICBFdXJvcGVhbiBOdW1iZXIgVGVybWluYXRvclxuICAvLyBuIChBTik6ICBBcmFiaWMgTnVtYmVyXG4gIC8vICwgKENTKTogIENvbW1vbiBOdW1iZXIgU2VwYXJhdG9yXG4gIC8vIG0gKE5TTSk6IE5vbi1TcGFjaW5nIE1hcmtcbiAgLy8gYiAoQk4pOiAgQm91bmRhcnkgTmV1dHJhbFxuICAvLyBzIChCKTogICBQYXJhZ3JhcGggU2VwYXJhdG9yXG4gIC8vIHQgKFMpOiAgIFNlZ21lbnQgU2VwYXJhdG9yXG4gIC8vIHcgKFdTKTogIFdoaXRlc3BhY2VcbiAgLy8gTiAoT04pOiAgT3RoZXIgTmV1dHJhbHNcblxuICAvLyBSZXR1cm5zIG51bGwgaWYgY2hhcmFjdGVycyBhcmUgb3JkZXJlZCBhcyB0aGV5IGFwcGVhclxuICAvLyAobGVmdC10by1yaWdodCksIG9yIGFuIGFycmF5IG9mIHNlY3Rpb25zICh7ZnJvbSwgdG8sIGxldmVsfVxuICAvLyBvYmplY3RzKSBpbiB0aGUgb3JkZXIgaW4gd2hpY2ggdGhleSBvY2N1ciB2aXN1YWxseS5cbiAgdmFyIGJpZGlPcmRlcmluZyA9IChmdW5jdGlvbigpIHtcbiAgICAvLyBDaGFyYWN0ZXIgdHlwZXMgZm9yIGNvZGVwb2ludHMgMCB0byAweGZmXG4gICAgdmFyIGxvd1R5cGVzID0gXCJiYmJiYmJiYmJ0c3R3c2JiYmJiYmJiYmJiYmJic3NzdHdOTiUlJU5OTk5OTixOLE4xMTExMTExMTExTk5OTk5OTkxMTExMTExMTExMTExMTExMTExMTExMTExMTk5OTk5OTExMTExMTExMTExMTExMTExMTExMTExMTExOTk5OYmJiYmJic2JiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiLE4lJSUlTk5OTkxOTk5OTiUlMTFOTE5OTjFMTk5OTk5MTExMTExMTExMTExMTExMTExMTExMTE5MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTlwiO1xuICAgIC8vIENoYXJhY3RlciB0eXBlcyBmb3IgY29kZXBvaW50cyAweDYwMCB0byAweDZmZlxuICAgIHZhciBhcmFiaWNUeXBlcyA9IFwicnJycnJycnJycnJyLHJOTm1tbW1tbXJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJybW1tbW1tbW1tbW1tbW1ycnJycnJybm5ubm5ubm5ubiVubnJycm1ycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycm1tbW1tbW1tbW1tbW1tbW1tbW1ObW1tbVwiO1xuICAgIGZ1bmN0aW9uIGNoYXJUeXBlKGNvZGUpIHtcbiAgICAgIGlmIChjb2RlIDw9IDB4ZjcpIHJldHVybiBsb3dUeXBlcy5jaGFyQXQoY29kZSk7XG4gICAgICBlbHNlIGlmICgweDU5MCA8PSBjb2RlICYmIGNvZGUgPD0gMHg1ZjQpIHJldHVybiBcIlJcIjtcbiAgICAgIGVsc2UgaWYgKDB4NjAwIDw9IGNvZGUgJiYgY29kZSA8PSAweDZlZCkgcmV0dXJuIGFyYWJpY1R5cGVzLmNoYXJBdChjb2RlIC0gMHg2MDApO1xuICAgICAgZWxzZSBpZiAoMHg2ZWUgPD0gY29kZSAmJiBjb2RlIDw9IDB4OGFjKSByZXR1cm4gXCJyXCI7XG4gICAgICBlbHNlIGlmICgweDIwMDAgPD0gY29kZSAmJiBjb2RlIDw9IDB4MjAwYikgcmV0dXJuIFwid1wiO1xuICAgICAgZWxzZSBpZiAoY29kZSA9PSAweDIwMGMpIHJldHVybiBcImJcIjtcbiAgICAgIGVsc2UgcmV0dXJuIFwiTFwiO1xuICAgIH1cblxuICAgIHZhciBiaWRpUkUgPSAvW1xcdTA1OTAtXFx1MDVmNFxcdTA2MDAtXFx1MDZmZlxcdTA3MDAtXFx1MDhhY10vO1xuICAgIHZhciBpc05ldXRyYWwgPSAvW3N0d05dLywgaXNTdHJvbmcgPSAvW0xScl0vLCBjb3VudHNBc0xlZnQgPSAvW0xiMW5dLywgY291bnRzQXNOdW0gPSAvWzFuXS87XG4gICAgLy8gQnJvd3NlcnMgc2VlbSB0byBhbHdheXMgdHJlYXQgdGhlIGJvdW5kYXJpZXMgb2YgYmxvY2sgZWxlbWVudHMgYXMgYmVpbmcgTC5cbiAgICB2YXIgb3V0ZXJUeXBlID0gXCJMXCI7XG5cbiAgICBmdW5jdGlvbiBCaWRpU3BhbihsZXZlbCwgZnJvbSwgdG8pIHtcbiAgICAgIHRoaXMubGV2ZWwgPSBsZXZlbDtcbiAgICAgIHRoaXMuZnJvbSA9IGZyb207IHRoaXMudG8gPSB0bztcbiAgICB9XG5cbiAgICByZXR1cm4gZnVuY3Rpb24oc3RyKSB7XG4gICAgICBpZiAoIWJpZGlSRS50ZXN0KHN0cikpIHJldHVybiBmYWxzZTtcbiAgICAgIHZhciBsZW4gPSBzdHIubGVuZ3RoLCB0eXBlcyA9IFtdO1xuICAgICAgZm9yICh2YXIgaSA9IDAsIHR5cGU7IGkgPCBsZW47ICsraSlcbiAgICAgICAgdHlwZXMucHVzaCh0eXBlID0gY2hhclR5cGUoc3RyLmNoYXJDb2RlQXQoaSkpKTtcblxuICAgICAgLy8gVzEuIEV4YW1pbmUgZWFjaCBub24tc3BhY2luZyBtYXJrIChOU00pIGluIHRoZSBsZXZlbCBydW4sIGFuZFxuICAgICAgLy8gY2hhbmdlIHRoZSB0eXBlIG9mIHRoZSBOU00gdG8gdGhlIHR5cGUgb2YgdGhlIHByZXZpb3VzXG4gICAgICAvLyBjaGFyYWN0ZXIuIElmIHRoZSBOU00gaXMgYXQgdGhlIHN0YXJ0IG9mIHRoZSBsZXZlbCBydW4sIGl0IHdpbGxcbiAgICAgIC8vIGdldCB0aGUgdHlwZSBvZiBzb3IuXG4gICAgICBmb3IgKHZhciBpID0gMCwgcHJldiA9IG91dGVyVHlwZTsgaSA8IGxlbjsgKytpKSB7XG4gICAgICAgIHZhciB0eXBlID0gdHlwZXNbaV07XG4gICAgICAgIGlmICh0eXBlID09IFwibVwiKSB0eXBlc1tpXSA9IHByZXY7XG4gICAgICAgIGVsc2UgcHJldiA9IHR5cGU7XG4gICAgICB9XG5cbiAgICAgIC8vIFcyLiBTZWFyY2ggYmFja3dhcmRzIGZyb20gZWFjaCBpbnN0YW5jZSBvZiBhIEV1cm9wZWFuIG51bWJlclxuICAgICAgLy8gdW50aWwgdGhlIGZpcnN0IHN0cm9uZyB0eXBlIChSLCBMLCBBTCwgb3Igc29yKSBpcyBmb3VuZC4gSWYgYW5cbiAgICAgIC8vIEFMIGlzIGZvdW5kLCBjaGFuZ2UgdGhlIHR5cGUgb2YgdGhlIEV1cm9wZWFuIG51bWJlciB0byBBcmFiaWNcbiAgICAgIC8vIG51bWJlci5cbiAgICAgIC8vIFczLiBDaGFuZ2UgYWxsIEFMcyB0byBSLlxuICAgICAgZm9yICh2YXIgaSA9IDAsIGN1ciA9IG91dGVyVHlwZTsgaSA8IGxlbjsgKytpKSB7XG4gICAgICAgIHZhciB0eXBlID0gdHlwZXNbaV07XG4gICAgICAgIGlmICh0eXBlID09IFwiMVwiICYmIGN1ciA9PSBcInJcIikgdHlwZXNbaV0gPSBcIm5cIjtcbiAgICAgICAgZWxzZSBpZiAoaXNTdHJvbmcudGVzdCh0eXBlKSkgeyBjdXIgPSB0eXBlOyBpZiAodHlwZSA9PSBcInJcIikgdHlwZXNbaV0gPSBcIlJcIjsgfVxuICAgICAgfVxuXG4gICAgICAvLyBXNC4gQSBzaW5nbGUgRXVyb3BlYW4gc2VwYXJhdG9yIGJldHdlZW4gdHdvIEV1cm9wZWFuIG51bWJlcnNcbiAgICAgIC8vIGNoYW5nZXMgdG8gYSBFdXJvcGVhbiBudW1iZXIuIEEgc2luZ2xlIGNvbW1vbiBzZXBhcmF0b3IgYmV0d2VlblxuICAgICAgLy8gdHdvIG51bWJlcnMgb2YgdGhlIHNhbWUgdHlwZSBjaGFuZ2VzIHRvIHRoYXQgdHlwZS5cbiAgICAgIGZvciAodmFyIGkgPSAxLCBwcmV2ID0gdHlwZXNbMF07IGkgPCBsZW4gLSAxOyArK2kpIHtcbiAgICAgICAgdmFyIHR5cGUgPSB0eXBlc1tpXTtcbiAgICAgICAgaWYgKHR5cGUgPT0gXCIrXCIgJiYgcHJldiA9PSBcIjFcIiAmJiB0eXBlc1tpKzFdID09IFwiMVwiKSB0eXBlc1tpXSA9IFwiMVwiO1xuICAgICAgICBlbHNlIGlmICh0eXBlID09IFwiLFwiICYmIHByZXYgPT0gdHlwZXNbaSsxXSAmJlxuICAgICAgICAgICAgICAgICAocHJldiA9PSBcIjFcIiB8fCBwcmV2ID09IFwiblwiKSkgdHlwZXNbaV0gPSBwcmV2O1xuICAgICAgICBwcmV2ID0gdHlwZTtcbiAgICAgIH1cblxuICAgICAgLy8gVzUuIEEgc2VxdWVuY2Ugb2YgRXVyb3BlYW4gdGVybWluYXRvcnMgYWRqYWNlbnQgdG8gRXVyb3BlYW5cbiAgICAgIC8vIG51bWJlcnMgY2hhbmdlcyB0byBhbGwgRXVyb3BlYW4gbnVtYmVycy5cbiAgICAgIC8vIFc2LiBPdGhlcndpc2UsIHNlcGFyYXRvcnMgYW5kIHRlcm1pbmF0b3JzIGNoYW5nZSB0byBPdGhlclxuICAgICAgLy8gTmV1dHJhbC5cbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuOyArK2kpIHtcbiAgICAgICAgdmFyIHR5cGUgPSB0eXBlc1tpXTtcbiAgICAgICAgaWYgKHR5cGUgPT0gXCIsXCIpIHR5cGVzW2ldID0gXCJOXCI7XG4gICAgICAgIGVsc2UgaWYgKHR5cGUgPT0gXCIlXCIpIHtcbiAgICAgICAgICBmb3IgKHZhciBlbmQgPSBpICsgMTsgZW5kIDwgbGVuICYmIHR5cGVzW2VuZF0gPT0gXCIlXCI7ICsrZW5kKSB7fVxuICAgICAgICAgIHZhciByZXBsYWNlID0gKGkgJiYgdHlwZXNbaS0xXSA9PSBcIiFcIikgfHwgKGVuZCA8IGxlbiAmJiB0eXBlc1tlbmRdID09IFwiMVwiKSA/IFwiMVwiIDogXCJOXCI7XG4gICAgICAgICAgZm9yICh2YXIgaiA9IGk7IGogPCBlbmQ7ICsraikgdHlwZXNbal0gPSByZXBsYWNlO1xuICAgICAgICAgIGkgPSBlbmQgLSAxO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFc3LiBTZWFyY2ggYmFja3dhcmRzIGZyb20gZWFjaCBpbnN0YW5jZSBvZiBhIEV1cm9wZWFuIG51bWJlclxuICAgICAgLy8gdW50aWwgdGhlIGZpcnN0IHN0cm9uZyB0eXBlIChSLCBMLCBvciBzb3IpIGlzIGZvdW5kLiBJZiBhbiBMIGlzXG4gICAgICAvLyBmb3VuZCwgdGhlbiBjaGFuZ2UgdGhlIHR5cGUgb2YgdGhlIEV1cm9wZWFuIG51bWJlciB0byBMLlxuICAgICAgZm9yICh2YXIgaSA9IDAsIGN1ciA9IG91dGVyVHlwZTsgaSA8IGxlbjsgKytpKSB7XG4gICAgICAgIHZhciB0eXBlID0gdHlwZXNbaV07XG4gICAgICAgIGlmIChjdXIgPT0gXCJMXCIgJiYgdHlwZSA9PSBcIjFcIikgdHlwZXNbaV0gPSBcIkxcIjtcbiAgICAgICAgZWxzZSBpZiAoaXNTdHJvbmcudGVzdCh0eXBlKSkgY3VyID0gdHlwZTtcbiAgICAgIH1cblxuICAgICAgLy8gTjEuIEEgc2VxdWVuY2Ugb2YgbmV1dHJhbHMgdGFrZXMgdGhlIGRpcmVjdGlvbiBvZiB0aGVcbiAgICAgIC8vIHN1cnJvdW5kaW5nIHN0cm9uZyB0ZXh0IGlmIHRoZSB0ZXh0IG9uIGJvdGggc2lkZXMgaGFzIHRoZSBzYW1lXG4gICAgICAvLyBkaXJlY3Rpb24uIEV1cm9wZWFuIGFuZCBBcmFiaWMgbnVtYmVycyBhY3QgYXMgaWYgdGhleSB3ZXJlIFIgaW5cbiAgICAgIC8vIHRlcm1zIG9mIHRoZWlyIGluZmx1ZW5jZSBvbiBuZXV0cmFscy4gU3RhcnQtb2YtbGV2ZWwtcnVuIChzb3IpXG4gICAgICAvLyBhbmQgZW5kLW9mLWxldmVsLXJ1biAoZW9yKSBhcmUgdXNlZCBhdCBsZXZlbCBydW4gYm91bmRhcmllcy5cbiAgICAgIC8vIE4yLiBBbnkgcmVtYWluaW5nIG5ldXRyYWxzIHRha2UgdGhlIGVtYmVkZGluZyBkaXJlY3Rpb24uXG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbjsgKytpKSB7XG4gICAgICAgIGlmIChpc05ldXRyYWwudGVzdCh0eXBlc1tpXSkpIHtcbiAgICAgICAgICBmb3IgKHZhciBlbmQgPSBpICsgMTsgZW5kIDwgbGVuICYmIGlzTmV1dHJhbC50ZXN0KHR5cGVzW2VuZF0pOyArK2VuZCkge31cbiAgICAgICAgICB2YXIgYmVmb3JlID0gKGkgPyB0eXBlc1tpLTFdIDogb3V0ZXJUeXBlKSA9PSBcIkxcIjtcbiAgICAgICAgICB2YXIgYWZ0ZXIgPSAoZW5kIDwgbGVuID8gdHlwZXNbZW5kXSA6IG91dGVyVHlwZSkgPT0gXCJMXCI7XG4gICAgICAgICAgdmFyIHJlcGxhY2UgPSBiZWZvcmUgfHwgYWZ0ZXIgPyBcIkxcIiA6IFwiUlwiO1xuICAgICAgICAgIGZvciAodmFyIGogPSBpOyBqIDwgZW5kOyArK2opIHR5cGVzW2pdID0gcmVwbGFjZTtcbiAgICAgICAgICBpID0gZW5kIC0gMTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBIZXJlIHdlIGRlcGFydCBmcm9tIHRoZSBkb2N1bWVudGVkIGFsZ29yaXRobSwgaW4gb3JkZXIgdG8gYXZvaWRcbiAgICAgIC8vIGJ1aWxkaW5nIHVwIGFuIGFjdHVhbCBsZXZlbHMgYXJyYXkuIFNpbmNlIHRoZXJlIGFyZSBvbmx5IHRocmVlXG4gICAgICAvLyBsZXZlbHMgKDAsIDEsIDIpIGluIGFuIGltcGxlbWVudGF0aW9uIHRoYXQgZG9lc24ndCB0YWtlXG4gICAgICAvLyBleHBsaWNpdCBlbWJlZGRpbmcgaW50byBhY2NvdW50LCB3ZSBjYW4gYnVpbGQgdXAgdGhlIG9yZGVyIG9uXG4gICAgICAvLyB0aGUgZmx5LCB3aXRob3V0IGZvbGxvd2luZyB0aGUgbGV2ZWwtYmFzZWQgYWxnb3JpdGhtLlxuICAgICAgdmFyIG9yZGVyID0gW10sIG07XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbjspIHtcbiAgICAgICAgaWYgKGNvdW50c0FzTGVmdC50ZXN0KHR5cGVzW2ldKSkge1xuICAgICAgICAgIHZhciBzdGFydCA9IGk7XG4gICAgICAgICAgZm9yICgrK2k7IGkgPCBsZW4gJiYgY291bnRzQXNMZWZ0LnRlc3QodHlwZXNbaV0pOyArK2kpIHt9XG4gICAgICAgICAgb3JkZXIucHVzaChuZXcgQmlkaVNwYW4oMCwgc3RhcnQsIGkpKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB2YXIgcG9zID0gaSwgYXQgPSBvcmRlci5sZW5ndGg7XG4gICAgICAgICAgZm9yICgrK2k7IGkgPCBsZW4gJiYgdHlwZXNbaV0gIT0gXCJMXCI7ICsraSkge31cbiAgICAgICAgICBmb3IgKHZhciBqID0gcG9zOyBqIDwgaTspIHtcbiAgICAgICAgICAgIGlmIChjb3VudHNBc051bS50ZXN0KHR5cGVzW2pdKSkge1xuICAgICAgICAgICAgICBpZiAocG9zIDwgaikgb3JkZXIuc3BsaWNlKGF0LCAwLCBuZXcgQmlkaVNwYW4oMSwgcG9zLCBqKSk7XG4gICAgICAgICAgICAgIHZhciBuc3RhcnQgPSBqO1xuICAgICAgICAgICAgICBmb3IgKCsrajsgaiA8IGkgJiYgY291bnRzQXNOdW0udGVzdCh0eXBlc1tqXSk7ICsraikge31cbiAgICAgICAgICAgICAgb3JkZXIuc3BsaWNlKGF0LCAwLCBuZXcgQmlkaVNwYW4oMiwgbnN0YXJ0LCBqKSk7XG4gICAgICAgICAgICAgIHBvcyA9IGo7XG4gICAgICAgICAgICB9IGVsc2UgKytqO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAocG9zIDwgaSkgb3JkZXIuc3BsaWNlKGF0LCAwLCBuZXcgQmlkaVNwYW4oMSwgcG9zLCBpKSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChvcmRlclswXS5sZXZlbCA9PSAxICYmIChtID0gc3RyLm1hdGNoKC9eXFxzKy8pKSkge1xuICAgICAgICBvcmRlclswXS5mcm9tID0gbVswXS5sZW5ndGg7XG4gICAgICAgIG9yZGVyLnVuc2hpZnQobmV3IEJpZGlTcGFuKDAsIDAsIG1bMF0ubGVuZ3RoKSk7XG4gICAgICB9XG4gICAgICBpZiAobHN0KG9yZGVyKS5sZXZlbCA9PSAxICYmIChtID0gc3RyLm1hdGNoKC9cXHMrJC8pKSkge1xuICAgICAgICBsc3Qob3JkZXIpLnRvIC09IG1bMF0ubGVuZ3RoO1xuICAgICAgICBvcmRlci5wdXNoKG5ldyBCaWRpU3BhbigwLCBsZW4gLSBtWzBdLmxlbmd0aCwgbGVuKSk7XG4gICAgICB9XG4gICAgICBpZiAob3JkZXJbMF0ubGV2ZWwgIT0gbHN0KG9yZGVyKS5sZXZlbClcbiAgICAgICAgb3JkZXIucHVzaChuZXcgQmlkaVNwYW4ob3JkZXJbMF0ubGV2ZWwsIGxlbiwgbGVuKSk7XG5cbiAgICAgIHJldHVybiBvcmRlcjtcbiAgICB9O1xuICB9KSgpO1xuXG4gIC8vIFRIRSBFTkRcblxuICBDb2RlTWlycm9yLnZlcnNpb24gPSBcIjQuNC4wXCI7XG5cbiAgcmV0dXJuIENvZGVNaXJyb3I7XG59KTtcbiIsInZhciBDb2RlTWlycm9yID0gcmVxdWlyZSgnY29kZW1pcnJvcicpO1xuXG4vLyBNQUdJQyFcbmZ1bmN0aW9uIHRyaW1Jbml0aWFsVGFicyhzdHIpIHtcbiAgdmFyIHRhYnNSZSA9IC8oXFx0KikvO1xuICB2YXIgdGFic01hdGNoZXMgPSB0YWJzUmUuZXhlYyhzdHIpO1xuICB2YXIgbnVtSW5pdGlhbFRhYnMgPSAwO1xuICBpZih0YWJzTWF0Y2hlcyAmJiB0YWJzTWF0Y2hlc1sxXSkge1xuICAgIG51bUluaXRpYWxUYWJzID0gdGFic01hdGNoZXNbMV0ubGVuZ3RoO1xuICB9XG4gIHZhciByZXBsYWNlbWVudFJlID0gbmV3IFJlZ0V4cCgnXlxcdHsnICsgbnVtSW5pdGlhbFRhYnMgKyAnfScpO1xuICB2YXIgbGluZXMgPSBzdHIuc3BsaXQoJ1xcbicpLm1hcChmdW5jdGlvbihsaW5lKSB7XG4gICAgcmV0dXJuIGxpbmUucmVwbGFjZShyZXBsYWNlbWVudFJlLCAnJyk7XG4gIH0pO1xuICByZXR1cm4gbGluZXMuam9pbignXFxuJyk7XG59XG5cbnZhciBleGVjdXRlID0gKGZ1bmN0aW9uIG1ha2VFdmFsKCkge1xuICB2YXIgY2hlYXR5RXZhbCA9IGV2YWw7XG4gIHJldHVybiBmdW5jdGlvbiAoc3RyKSB7XG4gICAgY2hlYXR5RXZhbChzdHIpO1xuICB9O1xufSkoKTtcblxuXG52YXIgcHJvdG8gPSBPYmplY3QuY3JlYXRlKEhUTUxFbGVtZW50LnByb3RvdHlwZSk7XG5cbnByb3RvLmNyZWF0ZWRDYWxsYmFjayA9IGZ1bmN0aW9uKCkge1xuICB0aGlzLmNtID0gbnVsbDtcblxuICB0aGlzLmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCBmdW5jdGlvbihlKSB7XG4gICAgaWYoZS5tZXRhS2V5ICYmIChlLmtleSA9PT0gJ2UnIHx8IGUua2V5Q29kZSA9PT0gNjkpKSB7XG4gICAgICB0aGlzLnJ1bkNvZGUoKTtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICB9XG4gIH0sIGZhbHNlKTtcbn07XG5cblxucHJvdG8uYXR0YWNoZWRDYWxsYmFjayA9IGZ1bmN0aW9uKCkge1xuICB2YXIgY29kZVNyYztcbiAgXG4gIGlmKHRoaXMuYXR0cmlidXRlcy5zcmMpIHtcbiAgICBjb2RlU3JjID0gdGhpcy5hdHRyaWJ1dGVzLnNyYy52YWx1ZTtcbiAgfVxuICBcbiAgaWYoY29kZVNyYyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhpcy5vbkNvZGVMb2FkZWQoJy8vIE5vIHNyYyBzcGVjaWZpZWQnKTtcbiAgfSBlbHNlIHtcbiAgICB0aGlzLmxvYWRDb2RlKGNvZGVTcmMpO1xuICB9XG5cbn07XG5cblxucHJvdG8ubG9hZENvZGUgPSBmdW5jdGlvbih1cmwpIHtcbiAgdmFyIHJlcXVlc3QgPSBuZXcgWE1MSHR0cFJlcXVlc3QoKTtcbiAgdmFyIHRoYXQgPSB0aGlzO1xuICByZXF1ZXN0Lm9wZW4oJ2dldCcsIHVybCwgdHJ1ZSk7XG4gIHJlcXVlc3QucmVzcG9uc2VUeXBlID0gJ3RleHQnO1xuICByZXF1ZXN0Lm9ubG9hZCA9IGZ1bmN0aW9uKCkge1xuICAgIHRoYXQub25Db2RlTG9hZGVkKHJlcXVlc3QucmVzcG9uc2UpO1xuICB9O1xuICByZXF1ZXN0Lm9uZXJyb3IgPSBmdW5jdGlvbigpIHtcbiAgICB0aGF0Lm9uQ29kZUxvYWRlZCgnLy8gRVJST1IgbG9hZGluZyAnICsgdXJsKTtcbiAgfTtcbiAgcmVxdWVzdC5zZW5kKCk7XG59O1xuXG5cbnByb3RvLm9uQ29kZUxvYWRlZCA9IGZ1bmN0aW9uKGNvZGUpIHtcbiAgdmFyIHRoYXQgPSB0aGlzO1xuICB2YXIgdGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCd0ZXh0YXJlYScpO1xuICB0aGlzLmlubmVySFRNTCA9ICcnO1xuICB0aGlzLmFwcGVuZENoaWxkKHRhKTtcbiAgXG4gIHZhciBjb2RlVmFsdWUgPSB0cmltSW5pdGlhbFRhYnMoY29kZSkudHJpbVJpZ2h0KCk7XG4gIHZhciBjbSA9IENvZGVNaXJyb3IoZnVuY3Rpb24oZWwpIHtcbiAgICAgIHRoYXQucmVwbGFjZUNoaWxkKGVsLCB0YSk7XG4gICAgfSwge1xuICAgICAgdmFsdWU6IGNvZGVWYWx1ZSxcbiAgICAgIC8qbGluZVdyYXBwaW5nOiB0cnVlLFxuICAgICAgbGluZU51bWJlcnM6IHRydWUsXG4gICAgICBzdHlsZUFjdGl2ZUxpbmU6IHRydWUsXG4gICAgICBtYXRjaEJyYWNrZXRzOiB0cnVlLFxuICAgICAgc2hvd1RyYWlsaW5nU3BhY2U6IHRydWUsKi9cbiAgICB9XG4gICk7XG4gIHRoaXMuY20gPSBjbTtcblxuICB2YXIgZXZ0ID0gZG9jdW1lbnQuY3JlYXRlRXZlbnQoJ0N1c3RvbUV2ZW50Jyk7XG4gIGV2dC5pbml0Q3VzdG9tRXZlbnQoJ2xvYWRlZCcsIGZhbHNlLCBmYWxzZSwge30pO1xuICB0aGlzLmRpc3BhdGNoRXZlbnQoZXZ0KTtcblxufTtcblxuXG5wcm90by5ydW5Db2RlID0gZnVuY3Rpb24oKSB7XG5cbiAgaWYoIXRoaXMuY20pIHtcbiAgICBjb25zb2xlLmxvZygnbm90aGluZyB0byBydW4hJyk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHZhciBjb2RlID0gdGhpcy5jbS5nZXRTZWxlY3Rpb24oKS50cmltKCk7XG5cbiAgLy8gQWgsIGJ1dCBub3RoaW5nJ3Mgc2VsZWN0ZWQsIHNvIHdlJ2xsIGZpbmQgd2hlcmUgdGhlIGN1cnNvciBpc1xuICAvLyBhbmQgZXhlY3V0ZSB0aGF0IGxpbmUgb25seVxuICBpZihjb2RlLmxlbmd0aCA9PT0gMCkge1xuICAgIHZhciBjdXJzb3IgPSB0aGlzLmNtLmdldEN1cnNvcigpO1xuICAgIGNvZGUgPSB0aGlzLmNtLmdldExpbmUoY3Vyc29yLmxpbmUpO1xuICB9XG5cbiAgZXhlY3V0ZShjb2RlKTtcblxufTtcblxucHJvdG8ucnVuQWxsQ29kZSA9IGZ1bmN0aW9uKCkge1xuICB2YXIgY29kZSA9IHRoaXMuY20uZ2V0VmFsdWUoKTtcbiAgZXhlY3V0ZShjb2RlKTtcbn07XG5cblxuZnVuY3Rpb24gWEVkaXRvcihlbGVtZW50TmFtZSkge1xuXG4gIGRvY3VtZW50LnJlZ2lzdGVyRWxlbWVudChlbGVtZW50TmFtZSwge1xuXHRcdHByb3RvdHlwZTogcHJvdG9cblx0fSk7XG5cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBYRWRpdG9yO1xuXG4iLCJ2YXIgZWxlbWVudCA9IHJlcXVpcmUoJy4vZWxlbWVudC5qcycpO1xuZWxlbWVudCgneC1lZGl0b3InKTtcbiJdfQ==
