(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
// CodeMirror is the only global var we claim
module.exports = (function() {
  "use strict";

  // BROWSER SNIFFING

  // Crude, but necessary to handle a number of hard-to-feature-detect
  // bugs and behavior differences.
  var gecko = /gecko\/\d/i.test(navigator.userAgent);
  // IE11 currently doesn't count as 'ie', since it has almost none of
  // the same bugs as earlier versions. Use ie_gt10 to handle
  // incompatibilities in that version.
  var old_ie = /MSIE \d/.test(navigator.userAgent);
  var ie_lt8 = old_ie && (document.documentMode == null || document.documentMode < 8);
  var ie_lt9 = old_ie && (document.documentMode == null || document.documentMode < 9);
  var ie_lt10 = old_ie && (document.documentMode == null || document.documentMode < 10);
  var ie_gt10 = /Trident\/([7-9]|\d{2,})\./.test(navigator.userAgent);
  var ie = old_ie || ie_gt10;
  var webkit = /WebKit\//.test(navigator.userAgent);
  var qtwebkit = webkit && /Qt\/\d+\.\d+/.test(navigator.userAgent);
  var chrome = /Chrome\//.test(navigator.userAgent);
  var opera = /Opera\//.test(navigator.userAgent);
  var safari = /Apple Computer/.test(navigator.vendor);
  var khtml = /KHTML\//.test(navigator.userAgent);
  var mac_geLion = /Mac OS X 1\d\D([7-9]|\d\d)\D/.test(navigator.userAgent);
  var mac_geMountainLion = /Mac OS X 1\d\D([8-9]|\d\d)\D/.test(navigator.userAgent);
  var phantom = /PhantomJS/.test(navigator.userAgent);

  var ios = /AppleWebKit/.test(navigator.userAgent) && /Mobile\/\w+/.test(navigator.userAgent);
  // This is woefully incomplete. Suggestions for alternative methods welcome.
  var mobile = ios || /Android|webOS|BlackBerry|Opera Mini|Opera Mobi|IEMobile/i.test(navigator.userAgent);
  var mac = ios || /Mac/.test(navigator.platform);
  var windows = /win/i.test(navigator.platform);

  var opera_version = opera && navigator.userAgent.match(/Version\/(\d*\.\d*)/);
  if (opera_version) opera_version = Number(opera_version[1]);
  if (opera_version && opera_version >= 15) { opera = false; webkit = true; }
  // Some browsers use the wrong event properties to signal cmd/ctrl on OS X
  var flipCtrlCmd = mac && (qtwebkit || opera && (opera_version == null || opera_version < 12.11));
  var captureMiddleClick = gecko || (ie && !ie_lt9);

  // Optimize some code when these features are not used
  var sawReadOnlySpans = false, sawCollapsedSpans = false;

  // CONSTRUCTOR

  function CodeMirror(place, options) {
    if (!(this instanceof CodeMirror)) return new CodeMirror(place, options);

    this.options = options = options || {};
    // Determine effective options based on given values and defaults.
    for (var opt in defaults) if (!options.hasOwnProperty(opt) && defaults.hasOwnProperty(opt))
      options[opt] = defaults[opt];
    setGuttersForLineNumbers(options);

    var docStart = typeof options.value == "string" ? 0 : options.value.first;
    var display = this.display = makeDisplay(place, docStart);
    display.wrapper.CodeMirror = this;
    updateGutters(this);
    if (options.autofocus && !mobile) focusInput(this);

    this.state = {keyMaps: [],
                  overlays: [],
                  modeGen: 0,
                  overwrite: false, focused: false,
                  suppressEdits: false,
                  pasteIncoming: false, cutIncoming: false,
                  draggingText: false,
                  highlight: new Delayed()};

    themeChanged(this);
    if (options.lineWrapping)
      this.display.wrapper.className += " CodeMirror-wrap";

    var doc = options.value;
    if (typeof doc == "string") doc = new Doc(options.value, options.mode);
    operation(this, attachDoc)(this, doc);

    // Override magic textarea content restore that IE sometimes does
    // on our hidden textarea on reload
    if (old_ie) setTimeout(bind(resetInput, this, true), 20);

    registerEventHandlers(this);
    // IE throws unspecified error in certain cases, when
    // trying to access activeElement before onload
    var hasFocus; try { hasFocus = (document.activeElement == display.input); } catch(e) { }
    if (hasFocus || (options.autofocus && !mobile)) setTimeout(bind(onFocus, this), 20);
    else onBlur(this);

    operation(this, function() {
      for (var opt in optionHandlers)
        if (optionHandlers.propertyIsEnumerable(opt))
          optionHandlers[opt](this, options[opt], Init);
      for (var i = 0; i < initHooks.length; ++i) initHooks[i](this);
    })();
  }

  // DISPLAY CONSTRUCTOR

  function makeDisplay(place, docStart) {
    var d = {};

    var input = d.input = elt("textarea", null, null, "position: absolute; padding: 0; width: 1px; height: 1em; outline: none");
    if (webkit) input.style.width = "1000px";
    else input.setAttribute("wrap", "off");
    // if border: 0; -- iOS fails to open keyboard (issue #1287)
    if (ios) input.style.border = "1px solid black";
    input.setAttribute("autocorrect", "off"); input.setAttribute("autocapitalize", "off"); input.setAttribute("spellcheck", "false");

    // Wraps and hides input textarea
    d.inputDiv = elt("div", [input], null, "overflow: hidden; position: relative; width: 3px; height: 0px;");
    // The actual fake scrollbars.
    d.scrollbarH = elt("div", [elt("div", null, null, "height: 1px")], "CodeMirror-hscrollbar");
    d.scrollbarV = elt("div", [elt("div", null, null, "width: 1px")], "CodeMirror-vscrollbar");
    d.scrollbarFiller = elt("div", null, "CodeMirror-scrollbar-filler");
    d.gutterFiller = elt("div", null, "CodeMirror-gutter-filler");
    // DIVs containing the selection and the actual code
    d.lineDiv = elt("div", null, "CodeMirror-code");
    d.selectionDiv = elt("div", null, null, "position: relative; z-index: 1");
    // Blinky cursor, and element used to ensure cursor fits at the end of a line
    d.cursor = elt("div", "\u00a0", "CodeMirror-cursor");
    // Secondary cursor, shown when on a 'jump' in bi-directional text
    d.otherCursor = elt("div", "\u00a0", "CodeMirror-cursor CodeMirror-secondarycursor");
    // Used to measure text size
    d.measure = elt("div", null, "CodeMirror-measure");
    // Wraps everything that needs to exist inside the vertically-padded coordinate system
    d.lineSpace = elt("div", [d.measure, d.selectionDiv, d.lineDiv, d.cursor, d.otherCursor],
                         null, "position: relative; outline: none");
    // Moved around its parent to cover visible view
    d.mover = elt("div", [elt("div", [d.lineSpace], "CodeMirror-lines")], null, "position: relative");
    // Set to the height of the text, causes scrolling
    d.sizer = elt("div", [d.mover], "CodeMirror-sizer");
    // D is needed because behavior of elts with overflow: auto and padding is inconsistent across browsers
    d.heightForcer = elt("div", null, null, "position: absolute; height: " + scrollerCutOff + "px; width: 1px;");
    // Will contain the gutters, if any
    d.gutters = elt("div", null, "CodeMirror-gutters");
    d.lineGutter = null;
    // Provides scrolling
    d.scroller = elt("div", [d.sizer, d.heightForcer, d.gutters], "CodeMirror-scroll");
    d.scroller.setAttribute("tabIndex", "-1");
    // The element in which the editor lives.
    d.wrapper = elt("div", [d.inputDiv, d.scrollbarH, d.scrollbarV,
                            d.scrollbarFiller, d.gutterFiller, d.scroller], "CodeMirror");
    // Work around IE7 z-index bug
    if (ie_lt8) { d.gutters.style.zIndex = -1; d.scroller.style.paddingRight = 0; }
    if (place.appendChild) place.appendChild(d.wrapper); else place(d.wrapper);

    // Needed to hide big blue blinking cursor on Mobile Safari
    if (ios) input.style.width = "0px";
    if (!webkit) d.scroller.draggable = true;
    // Needed to handle Tab key in KHTML
    if (khtml) { d.inputDiv.style.height = "1px"; d.inputDiv.style.position = "absolute"; }
    // Need to set a minimum width to see the scrollbar on IE7 (but must not set it on IE8).
    else if (ie_lt8) d.scrollbarH.style.minWidth = d.scrollbarV.style.minWidth = "18px";

    // Current visible range (may be bigger than the view window).
    d.viewOffset = d.lastSizeC = 0;
    d.showingFrom = d.showingTo = docStart;

    // Used to only resize the line number gutter when necessary (when
    // the amount of lines crosses a boundary that makes its width change)
    d.lineNumWidth = d.lineNumInnerWidth = d.lineNumChars = null;
    // See readInput and resetInput
    d.prevInput = "";
    // Set to true when a non-horizontal-scrolling widget is added. As
    // an optimization, widget aligning is skipped when d is false.
    d.alignWidgets = false;
    // Flag that indicates whether we currently expect input to appear
    // (after some event like 'keypress' or 'input') and are polling
    // intensively.
    d.pollingFast = false;
    // Self-resetting timeout for the poller
    d.poll = new Delayed();

    d.cachedCharWidth = d.cachedTextHeight = d.cachedPaddingH = null;
    d.measureLineCache = [];
    d.measureLineCachePos = 0;

    // Tracks when resetInput has punted to just putting a short
    // string instead of the (large) selection.
    d.inaccurateSelection = false;

    // Tracks the maximum line length so that the horizontal scrollbar
    // can be kept static when scrolling.
    d.maxLine = null;
    d.maxLineLength = 0;
    d.maxLineChanged = false;

    // Used for measuring wheel scrolling granularity
    d.wheelDX = d.wheelDY = d.wheelStartX = d.wheelStartY = null;

    return d;
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
      cm.display.wrapper.className += " CodeMirror-wrap";
      cm.display.sizer.style.minWidth = "";
    } else {
      cm.display.wrapper.className = cm.display.wrapper.className.replace(" CodeMirror-wrap", "");
      computeMaxLength(cm);
    }
    estimateLineHeights(cm);
    regChange(cm);
    clearCaches(cm);
    setTimeout(function(){updateScrollbars(cm);}, 100);
  }

  function estimateHeight(cm) {
    var th = textHeight(cm.display), wrapping = cm.options.lineWrapping;
    var perLine = wrapping && Math.max(5, cm.display.scroller.clientWidth / charWidth(cm.display) - 3);
    return function(line) {
      if (lineIsHidden(cm.doc, line))
        return 0;
      else if (wrapping)
        return (Math.ceil(line.text.length / perLine) || 1) * th;
      else
        return th;
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
  }

  function lineLength(doc, line) {
    if (line.height == 0) return 0;
    var len = line.text.length, merged, cur = line;
    while (merged = collapsedSpanAtStart(cur)) {
      var found = merged.find();
      cur = getLine(doc, found.from.line);
      len += found.from.ch - found.to.ch;
    }
    cur = line;
    while (merged = collapsedSpanAtEnd(cur)) {
      var found = merged.find();
      len -= cur.text.length - found.from.ch;
      cur = getLine(doc, found.to.line);
      len += cur.text.length - found.to.ch;
    }
    return len;
  }

  function computeMaxLength(cm) {
    var d = cm.display, doc = cm.doc;
    d.maxLine = getLine(doc, doc.first);
    d.maxLineLength = lineLength(doc, d.maxLine);
    d.maxLineChanged = true;
    doc.iter(function(line) {
      var len = lineLength(doc, line);
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

  // Re-synchronize the fake scrollbars with the actual size of the
  // content. Optionally force a scrollTop.
  function updateScrollbars(cm) {
    var d = cm.display, docHeight = cm.doc.height;
    var totalHeight = docHeight + paddingVert(d);
    d.sizer.style.minHeight = d.heightForcer.style.top = totalHeight + "px";
    d.gutters.style.height = Math.max(totalHeight, d.scroller.clientHeight - scrollerCutOff) + "px";
    var scrollHeight = Math.max(totalHeight, d.scroller.scrollHeight);
    var needsH = d.scroller.scrollWidth > (d.scroller.clientWidth + 1);
    var needsV = scrollHeight > (d.scroller.clientHeight + 1);
    if (needsV) {
      d.scrollbarV.style.display = "block";
      d.scrollbarV.style.bottom = needsH ? scrollbarWidth(d.measure) + "px" : "0";
      // A bug in IE8 can cause this value to be negative, so guard it.
      d.scrollbarV.firstChild.style.height =
        Math.max(0, scrollHeight - d.scroller.clientHeight + d.scrollbarV.clientHeight) + "px";
    } else {
      d.scrollbarV.style.display = "";
      d.scrollbarV.firstChild.style.height = "0";
    }
    if (needsH) {
      d.scrollbarH.style.display = "block";
      d.scrollbarH.style.right = needsV ? scrollbarWidth(d.measure) + "px" : "0";
      d.scrollbarH.firstChild.style.width =
        (d.scroller.scrollWidth - d.scroller.clientWidth + d.scrollbarH.clientWidth) + "px";
    } else {
      d.scrollbarH.style.display = "";
      d.scrollbarH.firstChild.style.width = "0";
    }
    if (needsH && needsV) {
      d.scrollbarFiller.style.display = "block";
      d.scrollbarFiller.style.height = d.scrollbarFiller.style.width = scrollbarWidth(d.measure) + "px";
    } else d.scrollbarFiller.style.display = "";
    if (needsH && cm.options.coverGutterNextToScrollbar && cm.options.fixedGutter) {
      d.gutterFiller.style.display = "block";
      d.gutterFiller.style.height = scrollbarWidth(d.measure) + "px";
      d.gutterFiller.style.width = d.gutters.offsetWidth + "px";
    } else d.gutterFiller.style.display = "";

    if (mac_geLion && scrollbarWidth(d.measure) === 0) {
      d.scrollbarV.style.minWidth = d.scrollbarH.style.minHeight = mac_geMountainLion ? "18px" : "12px";
      d.scrollbarV.style.pointerEvents = d.scrollbarH.style.pointerEvents = "none";
    }
  }

  function visibleLines(display, doc, viewPort) {
    var top = display.scroller.scrollTop, height = display.wrapper.clientHeight;
    if (typeof viewPort == "number") top = viewPort;
    else if (viewPort) {top = viewPort.top; height = viewPort.bottom - viewPort.top;}
    top = Math.floor(top - paddingTop(display));
    var bottom = Math.ceil(top + height);
    return {from: lineAtHeight(doc, top), to: lineAtHeight(doc, bottom)};
  }

  // LINE NUMBERS

  function alignHorizontally(cm) {
    var display = cm.display;
    if (!display.alignWidgets && (!display.gutters.firstChild || !cm.options.fixedGutter)) return;
    var comp = compensateForHScroll(display) - display.scroller.scrollLeft + cm.doc.scrollLeft;
    var gutterW = display.gutters.offsetWidth, l = comp + "px";
    for (var n = display.lineDiv.firstChild; n; n = n.nextSibling) if (n.alignable) {
      for (var i = 0, a = n.alignable; i < a.length; ++i) a[i].style.left = l;
    }
    if (cm.options.fixedGutter)
      display.gutters.style.left = (comp + gutterW) + "px";
  }

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
      return true;
    }
    return false;
  }

  function lineNumberFor(options, i) {
    return String(options.lineNumberFormatter(i + options.firstLineNumber));
  }
  function compensateForHScroll(display) {
    return getRect(display.scroller).left - getRect(display.sizer).left;
  }

  // DISPLAY DRAWING

  function updateDisplay(cm, changes, viewPort, forced) {
    var oldFrom = cm.display.showingFrom, oldTo = cm.display.showingTo, updated;
    var visible = visibleLines(cm.display, cm.doc, viewPort);
    for (var first = true;; first = false) {
      var oldWidth = cm.display.scroller.clientWidth;
      if (!updateDisplayInner(cm, changes, visible, forced)) break;
      updated = true;
      changes = [];
      updateSelection(cm);
      updateScrollbars(cm);
      if (first && cm.options.lineWrapping && oldWidth != cm.display.scroller.clientWidth) {
        forced = true;
        continue;
      }
      forced = false;

      // Clip forced viewport to actual scrollable area
      if (viewPort)
        viewPort = Math.min(cm.display.scroller.scrollHeight - cm.display.scroller.clientHeight,
                            typeof viewPort == "number" ? viewPort : viewPort.top);
      visible = visibleLines(cm.display, cm.doc, viewPort);
      if (visible.from >= cm.display.showingFrom && visible.to <= cm.display.showingTo)
        break;
    }

    if (updated) {
      signalLater(cm, "update", cm);
      if (cm.display.showingFrom != oldFrom || cm.display.showingTo != oldTo)
        signalLater(cm, "viewportChange", cm, cm.display.showingFrom, cm.display.showingTo);
    }
    return updated;
  }

  // Uses a set of changes plus the current scroll position to
  // determine which DOM updates have to be made, and makes the
  // updates.
  function updateDisplayInner(cm, changes, visible, forced) {
    var display = cm.display, doc = cm.doc;
    if (!display.wrapper.offsetWidth) {
      display.showingFrom = display.showingTo = doc.first;
      display.viewOffset = 0;
      return;
    }

    // Bail out if the visible area is already rendered and nothing changed.
    if (!forced && changes.length == 0 &&
        visible.from > display.showingFrom && visible.to < display.showingTo)
      return;

    if (maybeUpdateLineNumberWidth(cm))
      changes = [{from: doc.first, to: doc.first + doc.size}];
    var gutterW = display.sizer.style.marginLeft = display.gutters.offsetWidth + "px";
    display.scrollbarH.style.left = cm.options.fixedGutter ? gutterW : "0";

    // Used to determine which lines need their line numbers updated
    var positionsChangedFrom = Infinity;
    if (cm.options.lineNumbers)
      for (var i = 0; i < changes.length; ++i)
        if (changes[i].diff && changes[i].from < positionsChangedFrom) { positionsChangedFrom = changes[i].from; }

    var end = doc.first + doc.size;
    var from = Math.max(visible.from - cm.options.viewportMargin, doc.first);
    var to = Math.min(end, visible.to + cm.options.viewportMargin);
    if (display.showingFrom < from && from - display.showingFrom < 20) from = Math.max(doc.first, display.showingFrom);
    if (display.showingTo > to && display.showingTo - to < 20) to = Math.min(end, display.showingTo);
    if (sawCollapsedSpans) {
      from = lineNo(visualLine(doc, getLine(doc, from)));
      while (to < end && lineIsHidden(doc, getLine(doc, to))) ++to;
    }

    // Create a range of theoretically intact lines, and punch holes
    // in that using the change info.
    var intact = [{from: Math.max(display.showingFrom, doc.first),
                   to: Math.min(display.showingTo, end)}];
    if (intact[0].from >= intact[0].to) intact = [];
    else intact = computeIntact(intact, changes);
    // When merged lines are present, we might have to reduce the
    // intact ranges because changes in continued fragments of the
    // intact lines do require the lines to be redrawn.
    if (sawCollapsedSpans)
      for (var i = 0; i < intact.length; ++i) {
        var range = intact[i], merged;
        while (merged = collapsedSpanAtEnd(getLine(doc, range.to - 1))) {
          var newTo = merged.find().from.line;
          if (newTo > range.from) range.to = newTo;
          else { intact.splice(i--, 1); break; }
        }
      }

    // Clip off the parts that won't be visible
    var intactLines = 0;
    for (var i = 0; i < intact.length; ++i) {
      var range = intact[i];
      if (range.from < from) range.from = from;
      if (range.to > to) range.to = to;
      if (range.from >= range.to) intact.splice(i--, 1);
      else intactLines += range.to - range.from;
    }
    if (!forced && intactLines == to - from && from == display.showingFrom && to == display.showingTo) {
      updateViewOffset(cm);
      return;
    }
    intact.sort(function(a, b) {return a.from - b.from;});

    // Avoid crashing on IE's "unspecified error" when in iframes
    try {
      var focused = document.activeElement;
    } catch(e) {}
    if (intactLines < (to - from) * .7) display.lineDiv.style.display = "none";
    patchDisplay(cm, from, to, intact, positionsChangedFrom);
    display.lineDiv.style.display = "";
    if (focused && document.activeElement != focused && focused.offsetHeight) focused.focus();

    var different = from != display.showingFrom || to != display.showingTo ||
      display.lastSizeC != display.wrapper.clientHeight;
    // This is just a bogus formula that detects when the editor is
    // resized or the font size changes.
    if (different) {
      display.lastSizeC = display.wrapper.clientHeight;
      startWorker(cm, 400);
    }
    display.showingFrom = from; display.showingTo = to;

    display.gutters.style.height = "";
    updateHeightsInViewport(cm);
    updateViewOffset(cm);

    return true;
  }

  function updateHeightsInViewport(cm) {
    var display = cm.display;
    var prevBottom = display.lineDiv.offsetTop;
    for (var node = display.lineDiv.firstChild, height; node; node = node.nextSibling) if (node.lineObj) {
      if (ie_lt8) {
        var bot = node.offsetTop + node.offsetHeight;
        height = bot - prevBottom;
        prevBottom = bot;
      } else {
        var box = getRect(node);
        height = box.bottom - box.top;
      }
      var diff = node.lineObj.height - height;
      if (height < 2) height = textHeight(display);
      if (diff > .001 || diff < -.001) {
        updateLineHeight(node.lineObj, height);
        var widgets = node.lineObj.widgets;
        if (widgets) for (var i = 0; i < widgets.length; ++i)
          widgets[i].height = widgets[i].node.offsetHeight;
      }
    }
  }

  function updateViewOffset(cm) {
    var off = cm.display.viewOffset = heightAtLine(cm, getLine(cm.doc, cm.display.showingFrom));
    // Position the mover div to align with the current virtual scroll position
    cm.display.mover.style.top = off + "px";
  }

  function computeIntact(intact, changes) {
    for (var i = 0, l = changes.length || 0; i < l; ++i) {
      var change = changes[i], intact2 = [], diff = change.diff || 0;
      for (var j = 0, l2 = intact.length; j < l2; ++j) {
        var range = intact[j];
        if (change.to <= range.from && change.diff) {
          intact2.push({from: range.from + diff, to: range.to + diff});
        } else if (change.to <= range.from || change.from >= range.to) {
          intact2.push(range);
        } else {
          if (change.from > range.from)
            intact2.push({from: range.from, to: change.from});
          if (change.to < range.to)
            intact2.push({from: change.to + diff, to: range.to + diff});
        }
      }
      intact = intact2;
    }
    return intact;
  }

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

  function patchDisplay(cm, from, to, intact, updateNumbersFrom) {
    var dims = getDimensions(cm);
    var display = cm.display, lineNumbers = cm.options.lineNumbers;
    if (!intact.length && (!webkit || !cm.display.currentWheelTarget))
      removeChildren(display.lineDiv);
    var container = display.lineDiv, cur = container.firstChild;

    function rm(node) {
      var next = node.nextSibling;
      if (webkit && mac && cm.display.currentWheelTarget == node) {
        node.style.display = "none";
        node.lineObj = null;
      } else {
        node.parentNode.removeChild(node);
      }
      return next;
    }

    var nextIntact = intact.shift(), lineN = from;
    cm.doc.iter(from, to, function(line) {
      if (nextIntact && nextIntact.to == lineN) nextIntact = intact.shift();
      if (lineIsHidden(cm.doc, line)) {
        if (line.height != 0) updateLineHeight(line, 0);
        if (line.widgets && cur && cur.previousSibling) for (var i = 0; i < line.widgets.length; ++i) {
          var w = line.widgets[i];
          if (w.showIfHidden) {
            var prev = cur.previousSibling;
            if (/pre/i.test(prev.nodeName)) {
              var wrap = elt("div", null, null, "position: relative");
              prev.parentNode.replaceChild(wrap, prev);
              wrap.appendChild(prev);
              prev = wrap;
            }
            var wnode = prev.appendChild(elt("div", [w.node], "CodeMirror-linewidget"));
            if (!w.handleMouseEvents) wnode.ignoreEvents = true;
            positionLineWidget(w, wnode, prev, dims);
          }
        }
      } else if (nextIntact && nextIntact.from <= lineN && nextIntact.to > lineN) {
        // This line is intact. Skip to the actual node. Update its
        // line number if needed.
        while (cur.lineObj != line) cur = rm(cur);
        if (lineNumbers && updateNumbersFrom <= lineN && cur.lineNumber)
          setTextContent(cur.lineNumber, lineNumberFor(cm.options, lineN));
        cur = cur.nextSibling;
      } else {
        // For lines with widgets, make an attempt to find and reuse
        // the existing element, so that widgets aren't needlessly
        // removed and re-inserted into the dom
        if (line.widgets) for (var j = 0, search = cur, reuse; search && j < 20; ++j, search = search.nextSibling)
          if (search.lineObj == line && /div/i.test(search.nodeName)) { reuse = search; break; }
        // This line needs to be generated.
        var lineNode = buildLineElement(cm, line, lineN, dims, reuse);
        if (lineNode != reuse) {
          container.insertBefore(lineNode, cur);
        } else {
          while (cur != reuse) cur = rm(cur);
          cur = cur.nextSibling;
        }

        lineNode.lineObj = line;
      }
      ++lineN;
    });
    while (cur) cur = rm(cur);
  }

  function buildLineElement(cm, line, lineNo, dims, reuse) {
    var built = buildLineContent(cm, line), lineElement = built.pre;
    var markers = line.gutterMarkers, display = cm.display, wrap;

    var bgClass = built.bgClass ? built.bgClass + " " + (line.bgClass || "") : line.bgClass;
    if (!cm.options.lineNumbers && !markers && !bgClass && !line.wrapClass && !line.widgets)
      return lineElement;

    // Lines with gutter elements, widgets or a background class need
    // to be wrapped again, and have the extra elements added to the
    // wrapper div

    if (reuse) {
      reuse.alignable = null;
      var isOk = true, widgetsSeen = 0, insertBefore = null;
      for (var n = reuse.firstChild, next; n; n = next) {
        next = n.nextSibling;
        if (!/\bCodeMirror-linewidget\b/.test(n.className)) {
          reuse.removeChild(n);
        } else {
          for (var i = 0; i < line.widgets.length; ++i) {
            var widget = line.widgets[i];
            if (widget.node == n.firstChild) {
              if (!widget.above && !insertBefore) insertBefore = n;
              positionLineWidget(widget, n, reuse, dims);
              ++widgetsSeen;
              break;
            }
          }
          if (i == line.widgets.length) { isOk = false; break; }
        }
      }
      reuse.insertBefore(lineElement, insertBefore);
      if (isOk && widgetsSeen == line.widgets.length) {
        wrap = reuse;
        reuse.className = line.wrapClass || "";
      }
    }
    if (!wrap) {
      wrap = elt("div", null, line.wrapClass, "position: relative");
      wrap.appendChild(lineElement);
    }
    // Kludge to make sure the styled element lies behind the selection (by z-index)
    if (bgClass)
      wrap.insertBefore(elt("div", null, bgClass + " CodeMirror-linebackground"), wrap.firstChild);
    if (cm.options.lineNumbers || markers) {
      var gutterWrap = wrap.insertBefore(elt("div", null, "CodeMirror-gutter-wrapper", "position: absolute; left: " +
                                             (cm.options.fixedGutter ? dims.fixedPos : -dims.gutterTotalWidth) + "px"),
                                         lineElement);
      if (cm.options.fixedGutter) (wrap.alignable || (wrap.alignable = [])).push(gutterWrap);
      if (cm.options.lineNumbers && (!markers || !markers["CodeMirror-linenumbers"]))
        wrap.lineNumber = gutterWrap.appendChild(
          elt("div", lineNumberFor(cm.options, lineNo),
              "CodeMirror-linenumber CodeMirror-gutter-elt",
              "left: " + dims.gutterLeft["CodeMirror-linenumbers"] + "px; width: "
              + display.lineNumInnerWidth + "px"));
      if (markers)
        for (var k = 0; k < cm.options.gutters.length; ++k) {
          var id = cm.options.gutters[k], found = markers.hasOwnProperty(id) && markers[id];
          if (found)
            gutterWrap.appendChild(elt("div", [found], "CodeMirror-gutter-elt", "left: " +
                                       dims.gutterLeft[id] + "px; width: " + dims.gutterWidth[id] + "px"));
        }
    }
    if (ie_lt8) wrap.style.zIndex = 2;
    if (line.widgets && wrap != reuse) for (var i = 0, ws = line.widgets; i < ws.length; ++i) {
      var widget = ws[i], node = elt("div", [widget.node], "CodeMirror-linewidget");
      if (!widget.handleMouseEvents) node.ignoreEvents = true;
      positionLineWidget(widget, node, wrap, dims);
      if (widget.above)
        wrap.insertBefore(node, cm.options.lineNumbers && line.height != 0 ? gutterWrap : lineElement);
      else
        wrap.appendChild(node);
      signalLater(widget, "redraw");
    }
    return wrap;
  }

  function positionLineWidget(widget, node, wrap, dims) {
    if (widget.noHScroll) {
      (wrap.alignable || (wrap.alignable = [])).push(node);
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

  // SELECTION / CURSOR

  function updateSelection(cm) {
    var display = cm.display;
    var collapsed = posEq(cm.doc.sel.from, cm.doc.sel.to);
    if (collapsed || cm.options.showCursorWhenSelecting)
      updateSelectionCursor(cm);
    else
      display.cursor.style.display = display.otherCursor.style.display = "none";
    if (!collapsed)
      updateSelectionRange(cm);
    else
      display.selectionDiv.style.display = "none";

    // Move the hidden textarea near the cursor to prevent scrolling artifacts
    if (cm.options.moveInputWithCursor) {
      var headPos = cursorCoords(cm, cm.doc.sel.head, "div");
      var wrapOff = getRect(display.wrapper), lineOff = getRect(display.lineDiv);
      display.inputDiv.style.top = Math.max(0, Math.min(display.wrapper.clientHeight - 10,
                                                        headPos.top + lineOff.top - wrapOff.top)) + "px";
      display.inputDiv.style.left = Math.max(0, Math.min(display.wrapper.clientWidth - 10,
                                                         headPos.left + lineOff.left - wrapOff.left)) + "px";
    }
  }

  // No selection, plain cursor
  function updateSelectionCursor(cm) {
    var display = cm.display, pos = cursorCoords(cm, cm.doc.sel.head, "div");
    display.cursor.style.left = pos.left + "px";
    display.cursor.style.top = pos.top + "px";
    display.cursor.style.height = Math.max(0, pos.bottom - pos.top) * cm.options.cursorHeight + "px";
    display.cursor.style.display = "";

    if (pos.other) {
      display.otherCursor.style.display = "";
      display.otherCursor.style.left = pos.other.left + "px";
      display.otherCursor.style.top = pos.other.top + "px";
      display.otherCursor.style.height = (pos.other.bottom - pos.other.top) * .85 + "px";
    } else { display.otherCursor.style.display = "none"; }
  }

  // Highlight selection
  function updateSelectionRange(cm) {
    var display = cm.display, doc = cm.doc, sel = cm.doc.sel;
    var fragment = document.createDocumentFragment();
    var padding = paddingH(cm.display), leftSide = padding.left, rightSide = display.lineSpace.offsetWidth - padding.right;

    function add(left, top, width, bottom) {
      if (top < 0) top = 0;
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

    if (sel.from.line == sel.to.line) {
      drawForLine(sel.from.line, sel.from.ch, sel.to.ch);
    } else {
      var fromLine = getLine(doc, sel.from.line), toLine = getLine(doc, sel.to.line);
      var singleVLine = visualLine(doc, fromLine) == visualLine(doc, toLine);
      var leftEnd = drawForLine(sel.from.line, sel.from.ch, singleVLine ? fromLine.text.length : null).end;
      var rightStart = drawForLine(sel.to.line, singleVLine ? 0 : null, sel.to.ch).start;
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

    removeChildrenAndAdd(display.selectionDiv, fragment);
    display.selectionDiv.style.display = "";
  }

  // Cursor-blinking
  function restartBlink(cm) {
    if (!cm.state.focused) return;
    var display = cm.display;
    clearInterval(display.blinker);
    var on = true;
    display.cursor.style.visibility = display.otherCursor.style.visibility = "";
    if (cm.options.cursorBlinkRate > 0)
      display.blinker = setInterval(function() {
        display.cursor.style.visibility = display.otherCursor.style.visibility = (on = !on) ? "" : "hidden";
      }, cm.options.cursorBlinkRate);
  }

  // HIGHLIGHT WORKER

  function startWorker(cm, time) {
    if (cm.doc.mode.startState && cm.doc.frontier < cm.display.showingTo)
      cm.state.highlight.set(time, bind(highlightWorker, cm));
  }

  function highlightWorker(cm) {
    var doc = cm.doc;
    if (doc.frontier < doc.first) doc.frontier = doc.first;
    if (doc.frontier >= cm.display.showingTo) return;
    var end = +new Date + cm.options.workTime;
    var state = copyState(doc.mode, getStateBefore(cm, doc.frontier));
    var changed = [], prevChange;
    doc.iter(doc.frontier, Math.min(doc.first + doc.size, cm.display.showingTo + 500), function(line) {
      if (doc.frontier >= cm.display.showingFrom) { // Visible
        var oldStyles = line.styles;
        line.styles = highlightLine(cm, line, state, true);
        var ischange = !oldStyles || oldStyles.length != line.styles.length;
        for (var i = 0; !ischange && i < oldStyles.length; ++i) ischange = oldStyles[i] != line.styles[i];
        if (ischange) {
          if (prevChange && prevChange.end == doc.frontier) prevChange.end++;
          else changed.push(prevChange = {start: doc.frontier, end: doc.frontier + 1});
        }
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
    if (changed.length)
      operation(cm, function() {
        for (var i = 0; i < changed.length; ++i)
          regChange(this, changed[i].start, changed[i].end);
      })();
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
      var save = pos == n - 1 || pos % 5 == 0 || pos >= display.showingFrom && pos < display.showingTo;
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
    return display.cachedPaddingH = {left: parseInt(style.paddingLeft),
                                     right: parseInt(style.paddingRight)};
  }

  function measureChar(cm, line, ch, data, bias) {
    var dir = -1;
    data = data || measureLine(cm, line);
    if (data.crude) {
      var left = data.left + ch * data.width;
      return {left: left, right: left + data.width, top: data.top, bottom: data.bottom};
    }

    for (var pos = ch;; pos += dir) {
      var r = data[pos];
      if (r) break;
      if (dir < 0 && pos == 0) dir = 1;
    }
    bias = pos > ch ? "left" : pos < ch ? "right" : bias;
    if (bias == "left" && r.leftSide) r = r.leftSide;
    else if (bias == "right" && r.rightSide) r = r.rightSide;
    return {left: pos < ch ? r.right : r.left,
            right: pos > ch ? r.left : r.right,
            top: r.top,
            bottom: r.bottom};
  }

  function findCachedMeasurement(cm, line) {
    var cache = cm.display.measureLineCache;
    for (var i = 0; i < cache.length; ++i) {
      var memo = cache[i];
      if (memo.text == line.text && memo.markedSpans == line.markedSpans &&
          cm.display.scroller.clientWidth == memo.width &&
          memo.classes == line.textClass + "|" + line.wrapClass)
        return memo;
    }
  }

  function clearCachedMeasurement(cm, line) {
    var exists = findCachedMeasurement(cm, line);
    if (exists) exists.text = exists.measure = exists.markedSpans = null;
  }

  function measureLine(cm, line) {
    // First look in the cache
    var cached = findCachedMeasurement(cm, line);
    if (cached) return cached.measure;

    // Failing that, recompute and store result in cache
    var measure = measureLineInner(cm, line);
    var cache = cm.display.measureLineCache;
    var memo = {text: line.text, width: cm.display.scroller.clientWidth,
                markedSpans: line.markedSpans, measure: measure,
                classes: line.textClass + "|" + line.wrapClass};
    if (cache.length == 16) cache[++cm.display.measureLineCachePos % 16] = memo;
    else cache.push(memo);
    return measure;
  }

  function measureLineInner(cm, line) {
    if (!cm.options.lineWrapping && line.text.length >= cm.options.crudeMeasuringFrom)
      return crudelyMeasureLine(cm, line);

    var display = cm.display, measure = emptyArray(line.text.length);
    var pre = buildLineContent(cm, line, measure, true).pre;

    // IE does not cache element positions of inline elements between
    // calls to getBoundingClientRect. This makes the loop below,
    // which gathers the positions of all the characters on the line,
    // do an amount of layout work quadratic to the number of
    // characters. When line wrapping is off, we try to improve things
    // by first subdividing the line into a bunch of inline blocks, so
    // that IE can reuse most of the layout information from caches
    // for those blocks. This does interfere with line wrapping, so it
    // doesn't work when wrapping is on, but in that case the
    // situation is slightly better, since IE does cache line-wrapping
    // information and only recomputes per-line.
    if (old_ie && !ie_lt8 && !cm.options.lineWrapping && pre.childNodes.length > 100) {
      var fragment = document.createDocumentFragment();
      var chunk = 10, n = pre.childNodes.length;
      for (var i = 0, chunks = Math.ceil(n / chunk); i < chunks; ++i) {
        var wrap = elt("div", null, null, "display: inline-block");
        for (var j = 0; j < chunk && n; ++j) {
          wrap.appendChild(pre.firstChild);
          --n;
        }
        fragment.appendChild(wrap);
      }
      pre.appendChild(fragment);
    }

    removeChildrenAndAdd(display.measure, pre);

    var outer = getRect(display.lineDiv);
    var vranges = [], data = emptyArray(line.text.length), maxBot = pre.offsetHeight;
    // Work around an IE7/8 bug where it will sometimes have randomly
    // replaced our pre with a clone at this point.
    if (ie_lt9 && display.measure.first != pre)
      removeChildrenAndAdd(display.measure, pre);

    function measureRect(rect) {
      var top = rect.top - outer.top, bot = rect.bottom - outer.top;
      if (bot > maxBot) bot = maxBot;
      if (top < 0) top = 0;
      for (var i = vranges.length - 2; i >= 0; i -= 2) {
        var rtop = vranges[i], rbot = vranges[i+1];
        if (rtop > bot || rbot < top) continue;
        if (rtop <= top && rbot >= bot ||
            top <= rtop && bot >= rbot ||
            Math.min(bot, rbot) - Math.max(top, rtop) >= (bot - top) >> 1) {
          vranges[i] = Math.min(top, rtop);
          vranges[i+1] = Math.max(bot, rbot);
          break;
        }
      }
      if (i < 0) { i = vranges.length; vranges.push(top, bot); }
      return {left: rect.left - outer.left,
              right: rect.right - outer.left,
              top: i, bottom: null};
    }
    function finishRect(rect) {
      rect.bottom = vranges[rect.top+1];
      rect.top = vranges[rect.top];
    }

    for (var i = 0, cur; i < measure.length; ++i) if (cur = measure[i]) {
      var node = cur, rect = null;
      // A widget might wrap, needs special care
      if (/\bCodeMirror-widget\b/.test(cur.className) && cur.getClientRects) {
        if (cur.firstChild.nodeType == 1) node = cur.firstChild;
        var rects = node.getClientRects();
        if (rects.length > 1) {
          rect = data[i] = measureRect(rects[0]);
          rect.rightSide = measureRect(rects[rects.length - 1]);
        }
      }
      if (!rect) rect = data[i] = measureRect(getRect(node));
      if (cur.measureRight) rect.right = getRect(cur.measureRight).left - outer.left;
      if (cur.leftSide) rect.leftSide = measureRect(getRect(cur.leftSide));
    }
    removeChildren(cm.display.measure);
    for (var i = 0, cur; i < data.length; ++i) if (cur = data[i]) {
      finishRect(cur);
      if (cur.leftSide) finishRect(cur.leftSide);
      if (cur.rightSide) finishRect(cur.rightSide);
    }
    return data;
  }

  function crudelyMeasureLine(cm, line) {
    var copy = new Line(line.text.slice(0, 100), null);
    if (line.textClass) copy.textClass = line.textClass;
    var measure = measureLineInner(cm, copy);
    var left = measureChar(cm, copy, 0, measure, "left");
    var right = measureChar(cm, copy, 99, measure, "right");
    return {crude: true, top: left.top, left: left.left, bottom: left.bottom, width: (right.right - left.left) / 100};
  }

  function measureLineWidth(cm, line) {
    var hasBadSpan = false;
    if (line.markedSpans) for (var i = 0; i < line.markedSpans; ++i) {
      var sp = line.markedSpans[i];
      if (sp.collapsed && (sp.to == null || sp.to == line.text.length)) hasBadSpan = true;
    }
    var cached = !hasBadSpan && findCachedMeasurement(cm, line);
    if (cached || line.text.length >= cm.options.crudeMeasuringFrom)
      return measureChar(cm, line, line.text.length, cached && cached.measure, "right").right;

    var pre = buildLineContent(cm, line, null, true).pre;
    var end = pre.appendChild(zeroWidthElement(cm.display.measure));
    removeChildrenAndAdd(cm.display.measure, pre);
    return getRect(end).right - getRect(cm.display.lineDiv).left;
  }

  function clearCaches(cm) {
    cm.display.measureLineCache.length = cm.display.measureLineCachePos = 0;
    cm.display.cachedCharWidth = cm.display.cachedTextHeight = cm.display.cachedPaddingH = null;
    if (!cm.options.lineWrapping) cm.display.maxLineChanged = true;
    cm.display.lineNumChars = null;
  }

  function pageScrollX() { return window.pageXOffset || (document.documentElement || document.body).scrollLeft; }
  function pageScrollY() { return window.pageYOffset || (document.documentElement || document.body).scrollTop; }

  // Context is one of "line", "div" (display.lineDiv), "local"/null (editor), or "page"
  function intoCoordSystem(cm, lineObj, rect, context) {
    if (lineObj.widgets) for (var i = 0; i < lineObj.widgets.length; ++i) if (lineObj.widgets[i].above) {
      var size = widgetHeight(lineObj.widgets[i]);
      rect.top += size; rect.bottom += size;
    }
    if (context == "line") return rect;
    if (!context) context = "local";
    var yOff = heightAtLine(cm, lineObj);
    if (context == "local") yOff += paddingTop(cm.display);
    else yOff -= cm.display.viewOffset;
    if (context == "page" || context == "window") {
      var lOff = getRect(cm.display.lineSpace);
      yOff += lOff.top + (context == "window" ? 0 : pageScrollY());
      var xOff = lOff.left + (context == "window" ? 0 : pageScrollX());
      rect.left += xOff; rect.right += xOff;
    }
    rect.top += yOff; rect.bottom += yOff;
    return rect;
  }

  // Context may be "window", "page", "div", or "local"/null
  // Result is in "div" coords
  function fromCoordSystem(cm, coords, context) {
    if (context == "div") return coords;
    var left = coords.left, top = coords.top;
    // First move into "page" coordinate system
    if (context == "page") {
      left -= pageScrollX();
      top -= pageScrollY();
    } else if (context == "local" || !context) {
      var localBox = getRect(cm.display.sizer);
      left += localBox.left;
      top += localBox.top;
    }

    var lineSpaceBox = getRect(cm.display.lineSpace);
    return {left: left - lineSpaceBox.left, top: top - lineSpaceBox.top};
  }

  function charCoords(cm, pos, context, lineObj, bias) {
    if (!lineObj) lineObj = getLine(cm.doc, pos.line);
    return intoCoordSystem(cm, lineObj, measureChar(cm, lineObj, pos.ch, null, bias), context);
  }

  function cursorCoords(cm, pos, context, lineObj, measurement) {
    lineObj = lineObj || getLine(cm.doc, pos.line);
    if (!measurement) measurement = measureLine(cm, lineObj);
    function get(ch, right) {
      var m = measureChar(cm, lineObj, ch, measurement, right ? "right" : "left");
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

  function PosWithInfo(line, ch, outside, xRel) {
    var pos = new Pos(line, ch);
    pos.xRel = xRel;
    if (outside) pos.outside = true;
    return pos;
  }

  // Coords must be lineSpace-local
  function coordsChar(cm, x, y) {
    var doc = cm.doc;
    y += cm.display.viewOffset;
    if (y < 0) return PosWithInfo(doc.first, 0, true, -1);
    var lineNo = lineAtHeight(doc, y), last = doc.first + doc.size - 1;
    if (lineNo > last)
      return PosWithInfo(doc.first + doc.size - 1, getLine(doc, last).text.length, true, 1);
    if (x < 0) x = 0;

    for (;;) {
      var lineObj = getLine(doc, lineNo);
      var found = coordsCharInner(cm, lineObj, lineNo, x, y);
      var merged = collapsedSpanAtEnd(lineObj);
      var mergedPos = merged && merged.find();
      if (merged && (found.ch > mergedPos.from.ch || found.ch == mergedPos.from.ch && found.xRel > 0))
        lineNo = mergedPos.to.line;
      else
        return found;
    }
  }

  function coordsCharInner(cm, lineObj, lineNo, x, y) {
    var innerOff = y - heightAtLine(cm, lineObj);
    var wrongLine = false, adjust = 2 * cm.display.wrapper.clientWidth;
    var measurement = measureLine(cm, lineObj);

    function getX(ch) {
      var sp = cursorCoords(cm, Pos(lineNo, ch), "line",
                            lineObj, measurement);
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
                              xDiff < 0 ? -1 : xDiff ? 1 : 0);
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

  function charWidth(display) {
    if (display.cachedCharWidth != null) return display.cachedCharWidth;
    var anchor = elt("span", "x");
    var pre = elt("pre", [anchor]);
    removeChildrenAndAdd(display.measure, pre);
    var width = anchor.offsetWidth;
    if (width > 2) display.cachedCharWidth = width;
    return width || 10;
  }

  // OPERATIONS

  // Operations are used to wrap changes in such a way that each
  // change won't have to update the cursor and display (which would
  // be awkward, slow, and error-prone), but instead updates are
  // batched and then all combined and executed at once.

  var nextOpId = 0;
  function startOperation(cm) {
    cm.curOp = {
      // An array of ranges of lines that have to be updated. See
      // updateDisplay.
      changes: [],
      forceUpdate: false,
      updateInput: null,
      userSelChange: null,
      textChanged: null,
      selectionChanged: false,
      cursorActivity: false,
      updateMaxLine: false,
      updateScrollPos: false,
      id: ++nextOpId
    };
    if (!delayedCallbackDepth++) delayedCallbacks = [];
  }

  function endOperation(cm) {
    var op = cm.curOp, doc = cm.doc, display = cm.display;
    cm.curOp = null;

    if (op.updateMaxLine) computeMaxLength(cm);
    if (display.maxLineChanged && !cm.options.lineWrapping && display.maxLine) {
      var width = measureLineWidth(cm, display.maxLine);
      display.sizer.style.minWidth = Math.max(0, width + 3) + "px";
      display.maxLineChanged = false;
      var maxScrollLeft = Math.max(0, display.sizer.offsetLeft + display.sizer.offsetWidth - display.scroller.clientWidth);
      if (maxScrollLeft < doc.scrollLeft && !op.updateScrollPos)
        setScrollLeft(cm, Math.min(display.scroller.scrollLeft, maxScrollLeft), true);
    }
    var newScrollPos, updated;
    if (op.updateScrollPos) {
      newScrollPos = op.updateScrollPos;
    } else if (op.selectionChanged && display.scroller.clientHeight) { // don't rescroll if not visible
      var coords = cursorCoords(cm, doc.sel.head);
      newScrollPos = calculateScrollPos(cm, coords.left, coords.top, coords.left, coords.bottom);
    }
    if (op.changes.length || op.forceUpdate || newScrollPos && newScrollPos.scrollTop != null) {
      updated = updateDisplay(cm, op.changes, newScrollPos && newScrollPos.scrollTop, op.forceUpdate);
      if (cm.display.scroller.offsetHeight) cm.doc.scrollTop = cm.display.scroller.scrollTop;
    }
    if (!updated && op.selectionChanged) updateSelection(cm);
    if (op.updateScrollPos) {
      var top = Math.max(0, Math.min(display.scroller.scrollHeight - display.scroller.clientHeight, newScrollPos.scrollTop));
      var left = Math.max(0, Math.min(display.scroller.scrollWidth - display.scroller.clientWidth, newScrollPos.scrollLeft));
      display.scroller.scrollTop = display.scrollbarV.scrollTop = doc.scrollTop = top;
      display.scroller.scrollLeft = display.scrollbarH.scrollLeft = doc.scrollLeft = left;
      alignHorizontally(cm);
      if (op.scrollToPos)
        scrollPosIntoView(cm, clipPos(cm.doc, op.scrollToPos.from),
                          clipPos(cm.doc, op.scrollToPos.to), op.scrollToPos.margin);
    } else if (newScrollPos) {
      scrollCursorIntoView(cm);
    }
    if (op.selectionChanged) restartBlink(cm);

    if (cm.state.focused && op.updateInput)
      resetInput(cm, op.userSelChange);

    var hidden = op.maybeHiddenMarkers, unhidden = op.maybeUnhiddenMarkers;
    if (hidden) for (var i = 0; i < hidden.length; ++i)
      if (!hidden[i].lines.length) signal(hidden[i], "hide");
    if (unhidden) for (var i = 0; i < unhidden.length; ++i)
      if (unhidden[i].lines.length) signal(unhidden[i], "unhide");

    var delayed;
    if (!--delayedCallbackDepth) {
      delayed = delayedCallbacks;
      delayedCallbacks = null;
    }
    if (op.textChanged)
      signal(cm, "change", cm, op.textChanged);
    if (op.cursorActivity) signal(cm, "cursorActivity", cm);
    if (delayed) for (var i = 0; i < delayed.length; ++i) delayed[i]();
  }

  // Wraps a function in an operation. Returns the wrapped function.
  function operation(cm1, f) {
    return function() {
      var cm = cm1 || this, withOp = !cm.curOp;
      if (withOp) startOperation(cm);
      try { var result = f.apply(cm, arguments); }
      finally { if (withOp) endOperation(cm); }
      return result;
    };
  }
  function docOperation(f) {
    return function() {
      var withOp = this.cm && !this.cm.curOp, result;
      if (withOp) startOperation(this.cm);
      try { result = f.apply(this, arguments); }
      finally { if (withOp) endOperation(this.cm); }
      return result;
    };
  }
  function runInOp(cm, f) {
    var withOp = !cm.curOp, result;
    if (withOp) startOperation(cm);
    try { result = f(); }
    finally { if (withOp) endOperation(cm); }
    return result;
  }

  function regChange(cm, from, to, lendiff) {
    if (from == null) from = cm.doc.first;
    if (to == null) to = cm.doc.first + cm.doc.size;
    cm.curOp.changes.push({from: from, to: to, diff: lendiff});
  }

  // INPUT HANDLING

  function slowPoll(cm) {
    if (cm.display.pollingFast) return;
    cm.display.poll.set(cm.options.pollInterval, function() {
      readInput(cm);
      if (cm.state.focused) slowPoll(cm);
    });
  }

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

  // prevInput is a hack to work with IME. If we reset the textarea
  // on every change, that breaks IME. So we look for changes
  // compared to the previous content instead. (Modern browsers have
  // events that indicate IME taking place, but these are not widely
  // supported or compatible enough yet to rely on.)
  function readInput(cm) {
    var input = cm.display.input, prevInput = cm.display.prevInput, doc = cm.doc, sel = doc.sel;
    if (!cm.state.focused || hasSelection(input) || isReadOnly(cm) || cm.options.disableInput) return false;
    if (cm.state.pasteIncoming && cm.state.fakedLastChar) {
      input.value = input.value.substring(0, input.value.length - 1);
      cm.state.fakedLastChar = false;
    }
    var text = input.value;
    if (text == prevInput && posEq(sel.from, sel.to)) return false;
    if (ie && !ie_lt9 && cm.display.inputHasSelection === text) {
      resetInput(cm, true);
      return false;
    }

    var withOp = !cm.curOp;
    if (withOp) startOperation(cm);
    sel.shift = false;
    var same = 0, l = Math.min(prevInput.length, text.length);
    while (same < l && prevInput.charCodeAt(same) == text.charCodeAt(same)) ++same;
    var from = sel.from, to = sel.to;
    var inserted = text.slice(same);
    if (same < prevInput.length)
      from = Pos(from.line, from.ch - (prevInput.length - same));
    else if (cm.state.overwrite && posEq(from, to) && !cm.state.pasteIncoming)
      to = Pos(to.line, Math.min(getLine(doc, to.line).text.length, to.ch + inserted.length));

    var updateInput = cm.curOp.updateInput;
    var changeEvent = {from: from, to: to, text: splitLines(inserted),
                       origin: cm.state.pasteIncoming ? "paste" : cm.state.cutIncoming ? "cut" : "+input"};
    makeChange(cm.doc, changeEvent, "end");
    cm.curOp.updateInput = updateInput;
    signalLater(cm, "inputRead", cm, changeEvent);
    if (inserted && !cm.state.pasteIncoming && cm.options.electricChars &&
        cm.options.smartIndent && sel.head.ch < 100) {
      var electric = cm.getModeAt(sel.head).electricChars;
      if (electric) for (var i = 0; i < electric.length; i++)
        if (inserted.indexOf(electric.charAt(i)) > -1) {
          indentLine(cm, sel.head.line, "smart");
          break;
        }
    }

    if (text.length > 1000 || text.indexOf("\n") > -1) input.value = cm.display.prevInput = "";
    else cm.display.prevInput = text;
    if (withOp) endOperation(cm);
    cm.state.pasteIncoming = cm.state.cutIncoming = false;
    return true;
  }

  function resetInput(cm, user) {
    var minimal, selected, doc = cm.doc;
    if (!posEq(doc.sel.from, doc.sel.to)) {
      cm.display.prevInput = "";
      minimal = hasCopyEvent &&
        (doc.sel.to.line - doc.sel.from.line > 100 || (selected = cm.getSelection()).length > 1000);
      var content = minimal ? "-" : selected || cm.getSelection();
      cm.display.input.value = content;
      if (cm.state.focused) selectInput(cm.display.input);
      if (ie && !ie_lt9) cm.display.inputHasSelection = content;
    } else if (user) {
      cm.display.prevInput = cm.display.input.value = "";
      if (ie && !ie_lt9) cm.display.inputHasSelection = null;
    }
    cm.display.inaccurateSelection = minimal;
  }

  function focusInput(cm) {
    if (cm.options.readOnly != "nocursor" && (!mobile || document.activeElement != cm.display.input))
      cm.display.input.focus();
  }

  function ensureFocus(cm) {
    if (!cm.state.focused) { focusInput(cm); onFocus(cm); }
  }

  function isReadOnly(cm) {
    return cm.options.readOnly || cm.doc.cantEdit;
  }

  // EVENT HANDLERS

  function registerEventHandlers(cm) {
    var d = cm.display;
    on(d.scroller, "mousedown", operation(cm, onMouseDown));
    if (old_ie)
      on(d.scroller, "dblclick", operation(cm, function(e) {
        if (signalDOMEvent(cm, e)) return;
        var pos = posFromMouse(cm, e);
        if (!pos || clickInGutter(cm, e) || eventInWidget(cm.display, e)) return;
        e_preventDefault(e);
        var word = findWordAt(getLine(cm.doc, pos.line).text, pos);
        extendSelection(cm.doc, word.from, word.to);
      }));
    else
      on(d.scroller, "dblclick", function(e) { signalDOMEvent(cm, e) || e_preventDefault(e); });
    on(d.lineSpace, "selectstart", function(e) {
      if (!eventInWidget(d, e)) e_preventDefault(e);
    });
    // Gecko browsers fire contextmenu *after* opening the menu, at
    // which point we can't mess with it anymore. Context menu is
    // handled in onMouseDown for Gecko.
    if (!captureMiddleClick) on(d.scroller, "contextmenu", function(e) {onContextMenu(cm, e);});

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

    on(d.scroller, "mousewheel", function(e){onScrollWheel(cm, e);});
    on(d.scroller, "DOMMouseScroll", function(e){onScrollWheel(cm, e);});

    function reFocus() { if (cm.state.focused) setTimeout(bind(focusInput, cm), 0); }
    on(d.scrollbarH, "mousedown", reFocus);
    on(d.scrollbarV, "mousedown", reFocus);
    // Prevent wrapper from ever scrolling
    on(d.wrapper, "scroll", function() { d.wrapper.scrollTop = d.wrapper.scrollLeft = 0; });

    var resizeTimer;
    function onResize() {
      if (resizeTimer == null) resizeTimer = setTimeout(function() {
        resizeTimer = null;
        // Might be a text scaling operation, clear size caches.
        d.cachedCharWidth = d.cachedTextHeight = d.cachedPaddingH = knownScrollbarWidth = null;
        clearCaches(cm);
        runInOp(cm, bind(regChange, cm));
      }, 100);
    }
    on(window, "resize", onResize);
    // Above handler holds on to the editor and its data structures.
    // Here we poll to unregister it when the editor is no longer in
    // the document, so that it can be garbage-collected.
    function unregister() {
      for (var p = d.wrapper.parentNode; p && p != document.body; p = p.parentNode) {}
      if (p) setTimeout(unregister, 5000);
      else off(window, "resize", onResize);
    }
    setTimeout(unregister, 5000);

    on(d.input, "keyup", operation(cm, onKeyUp));
    on(d.input, "input", function() {
      if (ie && !ie_lt9 && cm.display.inputHasSelection) cm.display.inputHasSelection = null;
      fastPoll(cm);
    });
    on(d.input, "keydown", operation(cm, onKeyDown));
    on(d.input, "keypress", operation(cm, onKeyPress));
    on(d.input, "focus", bind(onFocus, cm));
    on(d.input, "blur", bind(onBlur, cm));

    function drag_(e) {
      if (signalDOMEvent(cm, e) || cm.options.onDragEvent && cm.options.onDragEvent(cm, addStop(e))) return;
      e_stop(e);
    }
    if (cm.options.dragDrop) {
      on(d.scroller, "dragstart", function(e){onDragStart(cm, e);});
      on(d.scroller, "dragenter", drag_);
      on(d.scroller, "dragover", drag_);
      on(d.scroller, "drop", operation(cm, onDrop));
    }
    on(d.scroller, "paste", function(e) {
      if (eventInWidget(d, e)) return;
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
        d.input.selectionStart = start;
        d.input.selectionEnd = end;
        cm.state.fakedLastChar = true;
      }
      cm.state.pasteIncoming = true;
      fastPoll(cm);
    });

    function prepareCopy(e) {
      if (d.inaccurateSelection) {
        d.prevInput = "";
        d.inaccurateSelection = false;
        d.input.value = cm.getSelection();
        selectInput(d.input);
      }
      if (e.type == "cut") cm.state.cutIncoming = true;
    }
    on(d.input, "cut", prepareCopy);
    on(d.input, "copy", prepareCopy);

    // Needed to handle Tab key in KHTML
    if (khtml) on(d.sizer, "mouseup", function() {
      if (document.activeElement == d.input) d.input.blur();
      focusInput(cm);
    });
  }

  function eventInWidget(display, e) {
    for (var n = e_target(e); n != display.wrapper; n = n.parentNode) {
      if (!n || n.ignoreEvents || n.parentNode == display.sizer && n != display.mover) return true;
    }
  }

  function posFromMouse(cm, e, liberal) {
    var display = cm.display;
    if (!liberal) {
      var target = e_target(e);
      if (target == display.scrollbarH || target == display.scrollbarH.firstChild ||
          target == display.scrollbarV || target == display.scrollbarV.firstChild ||
          target == display.scrollbarFiller || target == display.gutterFiller) return null;
    }
    var x, y, space = getRect(display.lineSpace);
    // Fails unpredictably on IE[67] when mouse is dragged around quickly.
    try { x = e.clientX; y = e.clientY; } catch (e) { return null; }
    return coordsChar(cm, x - space.left, y - space.top);
  }

  var lastClick, lastDoubleClick;
  function onMouseDown(e) {
    if (signalDOMEvent(this, e)) return;
    var cm = this, display = cm.display, doc = cm.doc, sel = doc.sel;
    sel.shift = e.shiftKey;

    if (eventInWidget(display, e)) {
      if (!webkit) {
        display.scroller.draggable = false;
        setTimeout(function(){display.scroller.draggable = true;}, 100);
      }
      return;
    }
    if (clickInGutter(cm, e)) return;
    var start = posFromMouse(cm, e);
    window.focus();

    switch (e_button(e)) {
    case 3:
      if (captureMiddleClick) onContextMenu.call(cm, cm, e);
      return;
    case 2:
      if (webkit) cm.state.lastMiddleDown = +new Date;
      if (start) extendSelection(cm.doc, start);
      setTimeout(bind(focusInput, cm), 20);
      e_preventDefault(e);
      return;
    }
    // For button 1, if it was clicked inside the editor
    // (posFromMouse returning non-null), we have to adjust the
    // selection.
    if (!start) {if (e_target(e) == display.scroller) e_preventDefault(e); return;}

    setTimeout(bind(ensureFocus, cm), 0);

    var now = +new Date, type = "single";
    if (lastDoubleClick && lastDoubleClick.time > now - 400 && posEq(lastDoubleClick.pos, start)) {
      type = "triple";
      e_preventDefault(e);
      setTimeout(bind(focusInput, cm), 20);
      selectLine(cm, start.line);
    } else if (lastClick && lastClick.time > now - 400 && posEq(lastClick.pos, start)) {
      type = "double";
      lastDoubleClick = {time: now, pos: start};
      e_preventDefault(e);
      var word = findWordAt(getLine(doc, start.line).text, start);
      extendSelection(cm.doc, word.from, word.to);
    } else { lastClick = {time: now, pos: start}; }

    var last = start;
    if (cm.options.dragDrop && dragAndDrop && !isReadOnly(cm) && !posEq(sel.from, sel.to) &&
        !posLess(start, sel.from) && !posLess(sel.to, start) && type == "single") {
      var dragEnd = operation(cm, function(e2) {
        if (webkit) display.scroller.draggable = false;
        cm.state.draggingText = false;
        off(document, "mouseup", dragEnd);
        off(display.scroller, "drop", dragEnd);
        if (Math.abs(e.clientX - e2.clientX) + Math.abs(e.clientY - e2.clientY) < 10) {
          e_preventDefault(e2);
          extendSelection(cm.doc, start);
          focusInput(cm);
          // Work around unexplainable focus problem in IE9 (#2127)
          if (old_ie && !ie_lt9)
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
      return;
    }
    e_preventDefault(e);
    if (type == "single") extendSelection(cm.doc, clipPos(doc, start));

    var startstart = sel.from, startend = sel.to, lastPos = start;

    function doSelect(cur) {
      if (posEq(lastPos, cur)) return;
      lastPos = cur;

      if (type == "single") {
        extendSelection(cm.doc, clipPos(doc, start), cur);
        return;
      }

      startstart = clipPos(doc, startstart);
      startend = clipPos(doc, startend);
      if (type == "double") {
        var word = findWordAt(getLine(doc, cur.line).text, cur);
        if (posLess(cur, startstart)) extendSelection(cm.doc, word.from, startend);
        else extendSelection(cm.doc, startstart, word.to);
      } else if (type == "triple") {
        if (posLess(cur, startstart)) extendSelection(cm.doc, startend, clipPos(doc, Pos(cur.line, 0)));
        else extendSelection(cm.doc, startstart, clipPos(doc, Pos(cur.line + 1, 0)));
      }
    }

    var editorSize = getRect(display.wrapper);
    // Used to ensure timeout re-tries don't fire when another extend
    // happened in the meantime (clearTimeout isn't reliable -- at
    // least on Chrome, the timeouts still happen even when cleared,
    // if the clear happens after their scheduled firing time).
    var counter = 0;

    function extend(e) {
      var curCount = ++counter;
      var cur = posFromMouse(cm, e, true);
      if (!cur) return;
      if (!posEq(cur, last)) {
        ensureFocus(cm);
        last = cur;
        doSelect(cur);
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
    }

    var move = operation(cm, function(e) {
      if ((ie && !ie_lt10) ?  !e.buttons : !e_button(e)) done(e);
      else extend(e);
    });
    var up = operation(cm, done);
    on(document, "mousemove", move);
    on(document, "mouseup", up);
  }

  function gutterEvent(cm, e, type, prevent, signalfn) {
    try { var mX = e.clientX, mY = e.clientY; }
    catch(e) { return false; }
    if (mX >= Math.floor(getRect(cm.display.gutters).right)) return false;
    if (prevent) e_preventDefault(e);

    var display = cm.display;
    var lineBox = getRect(display.lineDiv);

    if (mY > lineBox.bottom || !hasHandler(cm, type)) return e_defaultPrevented(e);
    mY -= lineBox.top - display.viewOffset;

    for (var i = 0; i < cm.options.gutters.length; ++i) {
      var g = display.gutters.childNodes[i];
      if (g && getRect(g).right >= mX) {
        var line = lineAtHeight(cm.doc, mY);
        var gutter = cm.options.gutters[i];
        signalfn(cm, type, cm, line, gutter, e);
        return e_defaultPrevented(e);
      }
    }
  }

  function contextMenuInGutter(cm, e) {
    if (!hasHandler(cm, "gutterContextMenu")) return false;
    return gutterEvent(cm, e, "gutterContextMenu", false, signal);
  }

  function clickInGutter(cm, e) {
    return gutterEvent(cm, e, "gutterClick", true, signalLater);
  }

  // Kludge to work around strange IE behavior where it'll sometimes
  // re-fire a series of drag-related events right after the drop (#1551)
  var lastDrop = 0;

  function onDrop(e) {
    var cm = this;
    if (signalDOMEvent(cm, e) || eventInWidget(cm.display, e) || (cm.options.onDragEvent && cm.options.onDragEvent(cm, addStop(e))))
      return;
    e_preventDefault(e);
    if (ie) lastDrop = +new Date;
    var pos = posFromMouse(cm, e, true), files = e.dataTransfer.files;
    if (!pos || isReadOnly(cm)) return;
    if (files && files.length && window.FileReader && window.File) {
      var n = files.length, text = Array(n), read = 0;
      var loadFile = function(file, i) {
        var reader = new FileReader;
        reader.onload = function() {
          text[i] = reader.result;
          if (++read == n) {
            pos = clipPos(cm.doc, pos);
            makeChange(cm.doc, {from: pos, to: pos, text: splitLines(text.join("\n")), origin: "paste"}, "around");
          }
        };
        reader.readAsText(file);
      };
      for (var i = 0; i < n; ++i) loadFile(files[i], i);
    } else {
      // Don't do a replace if the drop happened inside of the selected text.
      if (cm.state.draggingText && !(posLess(pos, cm.doc.sel.from) || posLess(cm.doc.sel.to, pos))) {
        cm.state.draggingText(e);
        // Ensure the editor is re-focused
        setTimeout(bind(focusInput, cm), 20);
        return;
      }
      try {
        var text = e.dataTransfer.getData("Text");
        if (text) {
          var curFrom = cm.doc.sel.from, curTo = cm.doc.sel.to;
          setSelection(cm.doc, pos, pos);
          if (cm.state.draggingText) replaceRange(cm.doc, "", curFrom, curTo, "paste");
          cm.replaceSelection(text, null, "paste");
          focusInput(cm);
        }
      }
      catch(e){}
    }
  }

  function onDragStart(cm, e) {
    if (ie && (!cm.state.draggingText || +new Date - lastDrop < 100)) { e_stop(e); return; }
    if (signalDOMEvent(cm, e) || eventInWidget(cm.display, e)) return;

    var txt = cm.getSelection();
    e.dataTransfer.setData("Text", txt);

    // Use dummy image instead of default browsers image.
    // Recent Safari (~6.0.2) have a tendency to segfault when this happens, so we don't do it there.
    if (e.dataTransfer.setDragImage && !safari) {
      var img = elt("img", null, null, "position: fixed; left: 0; top: 0;");
      img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
      if (opera) {
        img.width = img.height = 1;
        cm.display.wrapper.appendChild(img);
        // Force a relayout, or Opera won't use our image for some obscure reason
        img._top = img.offsetTop;
      }
      e.dataTransfer.setDragImage(img, 0, 0);
      if (opera) img.parentNode.removeChild(img);
    }
  }

  function setScrollTop(cm, val) {
    if (Math.abs(cm.doc.scrollTop - val) < 2) return;
    cm.doc.scrollTop = val;
    if (!gecko) updateDisplay(cm, [], val);
    if (cm.display.scroller.scrollTop != val) cm.display.scroller.scrollTop = val;
    if (cm.display.scrollbarV.scrollTop != val) cm.display.scrollbarV.scrollTop = val;
    if (gecko) updateDisplay(cm, []);
    startWorker(cm, 100);
  }
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
      for (var cur = e.target; cur != scroll; cur = cur.parentNode) {
        if (cur.lineObj) {
          cm.display.currentWheelTarget = cur;
          break;
        }
      }
    }

    // On some browsers, horizontal scrolling will cause redraws to
    // happen before the gutter has been realigned, causing it to
    // wriggle around in a most unseemly way. When we have an
    // estimated pixels/delta value, we just handle horizontal
    // scrolling entirely here. It'll be slightly off from native, but
    // better than glitching out.
    if (dx && !gecko && !opera && wheelPixelsPerUnit != null) {
      if (dy)
        setScrollTop(cm, Math.max(0, Math.min(scroll.scrollTop + dy * wheelPixelsPerUnit, scroll.scrollHeight - scroll.clientHeight)));
      setScrollLeft(cm, Math.max(0, Math.min(scroll.scrollLeft + dx * wheelPixelsPerUnit, scroll.scrollWidth - scroll.clientWidth)));
      e_preventDefault(e);
      display.wheelStartX = null; // Abort measurement, if in progress
      return;
    }

    if (dy && wheelPixelsPerUnit != null) {
      var pixels = dy * wheelPixelsPerUnit;
      var top = cm.doc.scrollTop, bot = top + display.wrapper.clientHeight;
      if (pixels < 0) top = Math.max(0, top + pixels - 50);
      else bot = Math.min(cm.doc.height, bot + pixels + 50);
      updateDisplay(cm, [], {top: top, bottom: bot});
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

  function doHandleBinding(cm, bound, dropShift) {
    if (typeof bound == "string") {
      bound = commands[bound];
      if (!bound) return false;
    }
    // Ensure previous input has been read, so that the handler sees a
    // consistent view of the document
    if (cm.display.pollingFast && readInput(cm)) cm.display.pollingFast = false;
    var doc = cm.doc, prevShift = doc.sel.shift, done = false;
    try {
      if (isReadOnly(cm)) cm.state.suppressEdits = true;
      if (dropShift) doc.sel.shift = false;
      done = bound(cm) != Pass;
    } finally {
      doc.sel.shift = prevShift;
      cm.state.suppressEdits = false;
    }
    return done;
  }

  function allKeyMaps(cm) {
    var maps = cm.state.keyMaps.slice(0);
    if (cm.options.extraKeys) maps.push(cm.options.extraKeys);
    maps.push(cm.options.keyMap);
    return maps;
  }

  var maybeTransition;
  function handleKeyBinding(cm, e) {
    // Handle auto keymap transitions
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
      if (ie_lt9) { e.oldKeyCode = e.keyCode; e.keyCode = 0; }
      signalLater(cm, "keyHandled", cm, name, e);
    }
    return handled;
  }

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

  function onKeyUp(e) {
    var cm = this;
    if (signalDOMEvent(cm, e) || cm.options.onKeyEvent && cm.options.onKeyEvent(cm, addStop(e))) return;
    if (e.keyCode == 16) cm.doc.sel.shift = false;
  }

  var lastStoppedKey = null;
  function onKeyDown(e) {
    var cm = this;
    ensureFocus(cm);
    if (signalDOMEvent(cm, e) || cm.options.onKeyEvent && cm.options.onKeyEvent(cm, addStop(e))) return;
    if (old_ie && e.keyCode == 27) e.returnValue = false;
    var code = e.keyCode;
    // IE does strange things with escape.
    cm.doc.sel.shift = code == 16 || e.shiftKey;
    // First give onKeyEvent option a chance to handle this.
    var handled = handleKeyBinding(cm, e);
    if (opera) {
      lastStoppedKey = handled ? code : null;
      // Opera has no cut event... we try to at least catch the key combo
      if (!handled && code == 88 && !hasCopyEvent && (mac ? e.metaKey : e.ctrlKey))
        cm.replaceSelection("");
    }
  }

  function onKeyPress(e) {
    var cm = this;
    if (signalDOMEvent(cm, e) || cm.options.onKeyEvent && cm.options.onKeyEvent(cm, addStop(e))) return;
    var keyCode = e.keyCode, charCode = e.charCode;
    if (opera && keyCode == lastStoppedKey) {lastStoppedKey = null; e_preventDefault(e); return;}
    if (((opera && (!e.which || e.which < 10)) || khtml) && handleKeyBinding(cm, e)) return;
    var ch = String.fromCharCode(charCode == null ? keyCode : charCode);
    if (handleCharBinding(cm, e, ch)) return;
    if (ie && !ie_lt9) cm.display.inputHasSelection = null;
    fastPoll(cm);
  }

  function onFocus(cm) {
    if (cm.options.readOnly == "nocursor") return;
    if (!cm.state.focused) {
      signal(cm, "focus", cm);
      cm.state.focused = true;
      if (cm.display.wrapper.className.search(/\bCodeMirror-focused\b/) == -1)
        cm.display.wrapper.className += " CodeMirror-focused";
      if (!cm.curOp) {
        resetInput(cm, true);
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
      cm.display.wrapper.className = cm.display.wrapper.className.replace(" CodeMirror-focused", "");
    }
    clearInterval(cm.display.blinker);
    setTimeout(function() {if (!cm.state.focused) cm.doc.sel.shift = false;}, 150);
  }

  var detectingSelectAll;
  function onContextMenu(cm, e) {
    if (signalDOMEvent(cm, e, "contextmenu")) return;
    var display = cm.display, sel = cm.doc.sel;
    if (eventInWidget(display, e) || contextMenuInGutter(cm, e)) return;

    var pos = posFromMouse(cm, e), scrollPos = display.scroller.scrollTop;
    if (!pos || opera) return; // Opera is difficult.

    // Reset the current text selection only if the click is done outside of the selection
    // and 'resetSelectionOnContextMenu' option is true.
    var reset = cm.options.resetSelectionOnContextMenu;
    if (reset && (posEq(sel.from, sel.to) || posLess(pos, sel.from) || !posLess(pos, sel.to)))
      operation(cm, setSelection)(cm.doc, pos, pos);

    var oldCSS = display.input.style.cssText;
    display.inputDiv.style.position = "absolute";
    display.input.style.cssText = "position: fixed; width: 30px; height: 30px; top: " + (e.clientY - 5) +
      "px; left: " + (e.clientX - 5) + "px; z-index: 1000; background: transparent; outline: none;" +
      "border-width: 0; outline: none; overflow: hidden; opacity: .05; -ms-opacity: .05; filter: alpha(opacity=5);";
    focusInput(cm);
    resetInput(cm, true);
    // Adds "Select all" to context menu in FF
    if (posEq(sel.from, sel.to)) display.input.value = display.prevInput = " ";

    function prepareSelectAllHack() {
      if (display.input.selectionStart != null) {
        var extval = display.input.value = "\u200b" + (posEq(sel.from, sel.to) ? "" : display.input.value);
        display.prevInput = "\u200b";
        display.input.selectionStart = 1; display.input.selectionEnd = extval.length;
      }
    }
    function rehide() {
      display.inputDiv.style.position = "relative";
      display.input.style.cssText = oldCSS;
      if (ie_lt9) display.scrollbarV.scrollTop = display.scroller.scrollTop = scrollPos;
      slowPoll(cm);

      // Try to detect the user choosing select-all
      if (display.input.selectionStart != null) {
        if (!ie || ie_lt9) prepareSelectAllHack();
        clearTimeout(detectingSelectAll);
        var i = 0, poll = function(){
          if (display.prevInput == "\u200b" && display.input.selectionStart == 0)
            operation(cm, commands.selectAll)(cm);
          else if (i++ < 10) detectingSelectAll = setTimeout(poll, 500);
          else resetInput(cm);
        };
        detectingSelectAll = setTimeout(poll, 200);
      }
    }

    if (ie && !ie_lt9) prepareSelectAllHack();
    if (captureMiddleClick) {
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

  // UPDATING

  var changeEnd = CodeMirror.changeEnd = function(change) {
    if (!change.text) return change.to;
    return Pos(change.from.line + change.text.length - 1,
               lst(change.text).length + (change.text.length == 1 ? change.from.ch : 0));
  };

  // Make sure a position will be valid after the given change.
  function clipPostChange(doc, change, pos) {
    if (!posLess(change.from, pos)) return clipPos(doc, pos);
    var diff = (change.text.length - 1) - (change.to.line - change.from.line);
    if (pos.line > change.to.line + diff) {
      var preLine = pos.line - diff, lastLine = doc.first + doc.size - 1;
      if (preLine > lastLine) return Pos(lastLine, getLine(doc, lastLine).text.length);
      return clipToLen(pos, getLine(doc, preLine).text.length);
    }
    if (pos.line == change.to.line + diff)
      return clipToLen(pos, lst(change.text).length + (change.text.length == 1 ? change.from.ch : 0) +
                       getLine(doc, change.to.line).text.length - change.to.ch);
    var inside = pos.line - change.from.line;
    return clipToLen(pos, change.text[inside].length + (inside ? 0 : change.from.ch));
  }

  // Hint can be null|"end"|"start"|"around"|{anchor,head}
  function computeSelAfterChange(doc, change, hint) {
    if (hint && typeof hint == "object") // Assumed to be {anchor, head} object
      return {anchor: clipPostChange(doc, change, hint.anchor),
              head: clipPostChange(doc, change, hint.head)};

    if (hint == "start") return {anchor: change.from, head: change.from};

    var end = changeEnd(change);
    if (hint == "around") return {anchor: change.from, head: end};
    if (hint == "end") return {anchor: end, head: end};

    // hint is null, leave the selection alone as much as possible
    var adjustPos = function(pos) {
      if (posLess(pos, change.from)) return pos;
      if (!posLess(change.to, pos)) return end;

      var line = pos.line + change.text.length - (change.to.line - change.from.line) - 1, ch = pos.ch;
      if (pos.line == change.to.line) ch += end.ch - change.to.ch;
      return Pos(line, ch);
    };
    return {anchor: adjustPos(doc.sel.anchor), head: adjustPos(doc.sel.head)};
  }

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

  // Replace the range from from to to by the strings in replacement.
  // change is a {from, to, text [, origin]} object
  function makeChange(doc, change, selUpdate, ignoreReadOnly) {
    if (doc.cm) {
      if (!doc.cm.curOp) return operation(doc.cm, makeChange)(doc, change, selUpdate, ignoreReadOnly);
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
      for (var i = split.length - 1; i >= 1; --i)
        makeChangeNoReadonly(doc, {from: split[i].from, to: split[i].to, text: [""]});
      if (split.length)
        makeChangeNoReadonly(doc, {from: split[0].from, to: split[0].to, text: change.text}, selUpdate);
    } else {
      makeChangeNoReadonly(doc, change, selUpdate);
    }
  }

  function makeChangeNoReadonly(doc, change, selUpdate) {
    if (change.text.length == 1 && change.text[0] == "" && posEq(change.from, change.to)) return;
    var selAfter = computeSelAfterChange(doc, change, selUpdate);
    addToHistory(doc, change, selAfter, doc.cm ? doc.cm.curOp.id : NaN);

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

  function makeChangeFromHistory(doc, type) {
    if (doc.cm && doc.cm.state.suppressEdits) return;

    var hist = doc.history;
    var event = (type == "undo" ? hist.done : hist.undone).pop();
    if (!event) return;

    var anti = {changes: [], anchorBefore: event.anchorAfter, headBefore: event.headAfter,
                anchorAfter: event.anchorBefore, headAfter: event.headBefore,
                generation: hist.generation};
    (type == "undo" ? hist.undone : hist.done).push(anti);
    hist.generation = event.generation || ++hist.maxGeneration;

    var filter = hasHandler(doc, "beforeChange") || doc.cm && hasHandler(doc.cm, "beforeChange");

    for (var i = event.changes.length - 1; i >= 0; --i) {
      var change = event.changes[i];
      change.origin = type;
      if (filter && !filterChange(doc, change, false)) {
        (type == "undo" ? hist.done : hist.undone).length = 0;
        return;
      }

      anti.changes.push(historyChangeFromChange(doc, change));

      var after = i ? computeSelAfterChange(doc, change, null)
                    : {anchor: event.anchorBefore, head: event.headBefore};
      makeChangeSingleDoc(doc, change, after, mergeOldSpans(doc, change));
      var rebased = [];

      linkedDocs(doc, function(doc, sharedHist) {
        if (!sharedHist && indexOf(rebased, doc.history) == -1) {
          rebaseHist(doc.history, change);
          rebased.push(doc.history);
        }
        makeChangeSingleDoc(doc, change, null, mergeOldSpans(doc, change));
      });
    }
  }

  function shiftDoc(doc, distance) {
    function shiftPos(pos) {return Pos(pos.line + distance, pos.ch);}
    doc.first += distance;
    if (doc.cm) regChange(doc.cm, doc.first, doc.first, distance);
    doc.sel.head = shiftPos(doc.sel.head); doc.sel.anchor = shiftPos(doc.sel.anchor);
    doc.sel.from = shiftPos(doc.sel.from); doc.sel.to = shiftPos(doc.sel.to);
  }

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

    if (!selAfter) selAfter = computeSelAfterChange(doc, change, null);
    if (doc.cm) makeChangeSingleDocInEditor(doc.cm, change, spans, selAfter);
    else updateDoc(doc, change, spans, selAfter);
  }

  function makeChangeSingleDocInEditor(cm, change, spans, selAfter) {
    var doc = cm.doc, display = cm.display, from = change.from, to = change.to;

    var recomputeMaxLength = false, checkWidthStart = from.line;
    if (!cm.options.lineWrapping) {
      checkWidthStart = lineNo(visualLine(doc, getLine(doc, from.line)));
      doc.iter(checkWidthStart, to.line + 1, function(line) {
        if (line == display.maxLine) {
          recomputeMaxLength = true;
          return true;
        }
      });
    }

    if (!posLess(doc.sel.head, change.from) && !posLess(change.to, doc.sel.head))
      cm.curOp.cursorActivity = true;

    updateDoc(doc, change, spans, selAfter, estimateHeight(cm));

    if (!cm.options.lineWrapping) {
      doc.iter(checkWidthStart, from.line + change.text.length, function(line) {
        var len = lineLength(doc, line);
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
    regChange(cm, from.line, to.line + 1, lendiff);

    if (hasHandler(cm, "change")) {
      var changeObj = {from: from, to: to,
                       text: change.text,
                       removed: change.removed,
                       origin: change.origin};
      if (cm.curOp.textChanged) {
        for (var cur = cm.curOp.textChanged; cur.next; cur = cur.next) {}
        cur.next = changeObj;
      } else cm.curOp.textChanged = changeObj;
    }
  }

  function replaceRange(doc, code, from, to, origin) {
    if (!to) to = from;
    if (posLess(to, from)) { var tmp = to; to = from; from = tmp; }
    if (typeof code == "string") code = splitLines(code);
    makeChange(doc, {from: from, to: to, text: code, origin: origin}, null);
  }

  // POSITION OBJECT

  function Pos(line, ch) {
    if (!(this instanceof Pos)) return new Pos(line, ch);
    this.line = line; this.ch = ch;
  }
  CodeMirror.Pos = Pos;

  function posEq(a, b) {return a.line == b.line && a.ch == b.ch;}
  function posLess(a, b) {return a.line < b.line || (a.line == b.line && a.ch < b.ch);}
  function cmp(a, b) {return a.line - b.line || a.ch - b.ch;}
  function copyPos(x) {return Pos(x.line, x.ch);}

  // SELECTION

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

  // If shift is held, this will move the selection anchor. Otherwise,
  // it'll set the whole selection.
  function extendSelection(doc, pos, other, bias) {
    if (doc.sel.shift || doc.sel.extend) {
      var anchor = doc.sel.anchor;
      if (other) {
        var posBefore = posLess(pos, anchor);
        if (posBefore != posLess(other, anchor)) {
          anchor = pos;
          pos = other;
        } else if (posBefore != posLess(pos, other)) {
          pos = other;
        }
      }
      setSelection(doc, anchor, pos, bias);
    } else {
      setSelection(doc, pos, other || pos, bias);
    }
    if (doc.cm) doc.cm.curOp.userSelChange = true;
  }

  function filterSelectionChange(doc, anchor, head) {
    var obj = {anchor: anchor, head: head};
    signal(doc, "beforeSelectionChange", doc, obj);
    if (doc.cm) signal(doc.cm, "beforeSelectionChange", doc.cm, obj);
    obj.anchor = clipPos(doc, obj.anchor); obj.head = clipPos(doc, obj.head);
    return obj;
  }

  // Update the selection. Last two args are only used by
  // updateDoc, since they have to be expressed in the line
  // numbers before the update.
  function setSelection(doc, anchor, head, bias, checkAtomic) {
    if (!checkAtomic && hasHandler(doc, "beforeSelectionChange") || doc.cm && hasHandler(doc.cm, "beforeSelectionChange")) {
      var filtered = filterSelectionChange(doc, anchor, head);
      head = filtered.head;
      anchor = filtered.anchor;
    }

    var sel = doc.sel;
    sel.goalColumn = null;
    if (bias == null) bias = posLess(head, sel.head) ? -1 : 1;
    // Skip over atomic spans.
    if (checkAtomic || !posEq(anchor, sel.anchor))
      anchor = skipAtomic(doc, anchor, bias, checkAtomic != "push");
    if (checkAtomic || !posEq(head, sel.head))
      head = skipAtomic(doc, head, bias, checkAtomic != "push");

    if (posEq(sel.anchor, anchor) && posEq(sel.head, head)) return;

    sel.anchor = anchor; sel.head = head;
    var inv = posLess(head, anchor);
    sel.from = inv ? head : anchor;
    sel.to = inv ? anchor : head;

    if (doc.cm)
      doc.cm.curOp.updateInput = doc.cm.curOp.selectionChanged =
        doc.cm.curOp.cursorActivity = true;

    signalLater(doc, "cursorActivity", doc);
  }

  function reCheckSelection(cm) {
    setSelection(cm.doc, cm.doc.sel.from, cm.doc.sel.to, null, "push");
  }

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
            var newPos = m.find()[dir < 0 ? "from" : "to"];
            if (posEq(newPos, curPos)) {
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

  // SCROLLING

  function scrollCursorIntoView(cm) {
    var coords = scrollPosIntoView(cm, cm.doc.sel.head, null, cm.options.cursorScrollMargin);
    if (!cm.state.focused) return;
    var display = cm.display, box = getRect(display.sizer), doScroll = null;
    if (coords.top + box.top < 0) doScroll = true;
    else if (coords.bottom + box.top > (window.innerHeight || document.documentElement.clientHeight)) doScroll = false;
    if (doScroll != null && !phantom) {
      var scrollNode = elt("div", "\u200b", null, "position: absolute; top: " +
                           (coords.top - display.viewOffset) + "px; height: " +
                           (coords.bottom - coords.top + scrollerCutOff) + "px; left: " +
                           coords.left + "px; width: 2px;");
      cm.display.lineSpace.appendChild(scrollNode);
      scrollNode.scrollIntoView(doScroll);
      cm.display.lineSpace.removeChild(scrollNode);
    }
  }

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

  function scrollIntoView(cm, x1, y1, x2, y2) {
    var scrollPos = calculateScrollPos(cm, x1, y1, x2, y2);
    if (scrollPos.scrollTop != null) setScrollTop(cm, scrollPos.scrollTop);
    if (scrollPos.scrollLeft != null) setScrollLeft(cm, scrollPos.scrollLeft);
  }

  function calculateScrollPos(cm, x1, y1, x2, y2) {
    var display = cm.display, snapMargin = textHeight(cm.display);
    if (y1 < 0) y1 = 0;
    var screen = display.scroller.clientHeight - scrollerCutOff, screentop = display.scroller.scrollTop, result = {};
    var docBottom = cm.doc.height + paddingVert(display);
    var atTop = y1 < snapMargin, atBottom = y2 > docBottom - snapMargin;
    if (y1 < screentop) {
      result.scrollTop = atTop ? 0 : y1;
    } else if (y2 > screentop + screen) {
      var newTop = Math.min(y1, (atBottom ? docBottom : y2) - screen);
      if (newTop != screentop) result.scrollTop = newTop;
    }

    var screenw = display.scroller.clientWidth - scrollerCutOff, screenleft = display.scroller.scrollLeft;
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

  function updateScrollPos(cm, left, top) {
    cm.curOp.updateScrollPos = {scrollLeft: left == null ? cm.doc.scrollLeft : left,
                                scrollTop: top == null ? cm.doc.scrollTop : top};
  }

  function addToScrollPos(cm, left, top) {
    var pos = cm.curOp.updateScrollPos || (cm.curOp.updateScrollPos = {scrollLeft: cm.doc.scrollLeft, scrollTop: cm.doc.scrollTop});
    var scroll = cm.display.scroller;
    pos.scrollTop = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, pos.scrollTop + top));
    pos.scrollLeft = Math.max(0, Math.min(scroll.scrollWidth - scroll.clientWidth, pos.scrollLeft + left));
  }

  // API UTILITIES

  function indentLine(cm, n, how, aggressive) {
    var doc = cm.doc, state;
    if (how == null) how = "add";
    if (how == "smart") {
      if (!cm.doc.mode.indent) how = "prev";
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
      indentation = cm.doc.mode.indent(state, line.text.slice(curSpaceString.length), line.text);
      if (indentation == Pass) {
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

    if (indentString != curSpaceString)
      replaceRange(cm.doc, indentString, Pos(n, 0), Pos(n, curSpaceString.length), "+input");
    else if (doc.sel.head.line == n && doc.sel.head.ch < curSpaceString.length)
      setSelection(doc, Pos(n, curSpaceString.length), Pos(n, curSpaceString.length), 1);
    line.stateAfter = null;
  }

  function changeLine(cm, handle, op) {
    var no = handle, line = handle, doc = cm.doc;
    if (typeof handle == "number") line = getLine(doc, clipLine(doc, handle));
    else no = lineNo(handle);
    if (no == null) return null;
    if (op(line, no)) regChange(cm, no, no + 1);
    else return null;
    return line;
  }

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
      for (var first = true;; first = false) {
        if (dir < 0 && !moveOnce(!first)) break;
        var cur = lineObj.text.charAt(ch) || "\n";
        var type = isWordChar(cur) ? "w"
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

  function findWordAt(line, pos) {
    var start = pos.ch, end = pos.ch;
    if (line) {
      if ((pos.xRel < 0 || end == line.length) && start) --start; else ++end;
      var startChar = line.charAt(start);
      var check = isWordChar(startChar) ? isWordChar
        : /\s/.test(startChar) ? function(ch) {return /\s/.test(ch);}
        : function(ch) {return !/\s/.test(ch) && !isWordChar(ch);};
      while (start > 0 && check(line.charAt(start - 1))) --start;
      while (end < line.length && check(line.charAt(end))) ++end;
    }
    return {from: Pos(pos.line, start), to: Pos(pos.line, end)};
  }

  function selectLine(cm, line) {
    extendSelection(cm.doc, Pos(line, 0), clipPos(cm.doc, Pos(line + 1, 0)));
  }

  // PROTOTYPE

  // The publicly visible API. Note that operation(null, f) means
  // 'wrap f in an operation, performed on its `this` parameter'

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

    addOverlay: operation(null, function(spec, options) {
      var mode = spec.token ? spec : CodeMirror.getMode(this.options, spec);
      if (mode.startState) throw new Error("Overlays may not be stateful.");
      this.state.overlays.push({mode: mode, modeSpec: spec, opaque: options && options.opaque});
      this.state.modeGen++;
      regChange(this);
    }),
    removeOverlay: operation(null, function(spec) {
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

    indentLine: operation(null, function(n, dir, aggressive) {
      if (typeof dir != "string" && typeof dir != "number") {
        if (dir == null) dir = this.options.smartIndent ? "smart" : "prev";
        else dir = dir ? "add" : "subtract";
      }
      if (isLine(this.doc, n)) indentLine(this, n, dir, aggressive);
    }),
    indentSelection: operation(null, function(how) {
      var sel = this.doc.sel;
      if (posEq(sel.from, sel.to)) return indentLine(this, sel.from.line, how, true);
      var e = sel.to.line - (sel.to.ch ? 0 : 1);
      for (var i = sel.from.line; i <= e; ++i) indentLine(this, i, how);
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
        var style = mode.token(stream, state);
      }
      return {start: stream.start,
              end: stream.pos,
              string: stream.current(),
              className: style || null, // Deprecated, use 'type' instead
              type: style || null,
              state: state};
    },

    getTokenTypeAt: function(pos) {
      pos = clipPos(this.doc, pos);
      var styles = getLineStyles(this, getLine(this.doc, pos.line));
      var before = 0, after = (styles.length - 1) / 2, ch = pos.ch;
      if (ch == 0) return styles[2];
      for (;;) {
        var mid = (before + after) >> 1;
        if ((mid ? styles[mid * 2 - 1] : 0) >= ch) after = mid;
        else if (styles[mid * 2 + 1] < ch) before = mid + 1;
        else return styles[mid * 2 + 2];
      }
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
      var pos, sel = this.doc.sel;
      if (start == null) pos = sel.head;
      else if (typeof start == "object") pos = clipPos(this.doc, start);
      else pos = start ? sel.from : sel.to;
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
      return intoCoordSystem(this, getLine(this.doc, line), {top: 0, left: 0}, mode || "page").top +
        (end ? lineObj.height : 0);
    },

    defaultTextHeight: function() { return textHeight(this.display); },
    defaultCharWidth: function() { return charWidth(this.display); },

    setGutterMarker: operation(null, function(line, gutterID, value) {
      return changeLine(this, line, function(line) {
        var markers = line.gutterMarkers || (line.gutterMarkers = {});
        markers[gutterID] = value;
        if (!value && isEmpty(markers)) line.gutterMarkers = null;
        return true;
      });
    }),

    clearGutter: operation(null, function(gutterID) {
      var cm = this, doc = cm.doc, i = doc.first;
      doc.iter(function(line) {
        if (line.gutterMarkers && line.gutterMarkers[gutterID]) {
          line.gutterMarkers[gutterID] = null;
          regChange(cm, i, i + 1);
          if (isEmpty(line.gutterMarkers)) line.gutterMarkers = null;
        }
        ++i;
      });
    }),

    addLineClass: operation(null, function(handle, where, cls) {
      return changeLine(this, handle, function(line) {
        var prop = where == "text" ? "textClass" : where == "background" ? "bgClass" : "wrapClass";
        if (!line[prop]) line[prop] = cls;
        else if (new RegExp("(?:^|\\s)" + cls + "(?:$|\\s)").test(line[prop])) return false;
        else line[prop] += " " + cls;
        return true;
      });
    }),

    removeLineClass: operation(null, function(handle, where, cls) {
      return changeLine(this, handle, function(line) {
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

    addLineWidget: operation(null, function(handle, node, options) {
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

    getViewport: function() { return {from: this.display.showingFrom, to: this.display.showingTo};},

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

    triggerOnKeyDown: operation(null, onKeyDown),
    triggerOnKeyPress: operation(null, onKeyPress),
    triggerOnKeyUp: operation(null, onKeyUp),

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

    moveH: operation(null, function(dir, unit) {
      var sel = this.doc.sel, pos;
      if (sel.shift || sel.extend || posEq(sel.from, sel.to))
        pos = findPosH(this.doc, sel.head, dir, unit, this.options.rtlMoveVisually);
      else
        pos = dir < 0 ? sel.from : sel.to;
      extendSelection(this.doc, pos, pos, dir);
    }),

    deleteH: operation(null, function(dir, unit) {
      var sel = this.doc.sel;
      if (!posEq(sel.from, sel.to)) replaceRange(this.doc, "", sel.from, sel.to, "+delete");
      else replaceRange(this.doc, "", sel.from, findPosH(this.doc, sel.head, dir, unit, false), "+delete");
      this.curOp.userSelChange = true;
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

    moveV: operation(null, function(dir, unit) {
      var sel = this.doc.sel, target, goal;
      if (sel.shift || sel.extend || posEq(sel.from, sel.to)) {
        var pos = cursorCoords(this, sel.head, "div");
        if (sel.goalColumn != null) pos.left = sel.goalColumn;
        target = findPosV(this, pos, dir, unit);
        if (unit == "page") addToScrollPos(this, 0, charCoords(this, target, "div").top - pos.top);
        goal = pos.left;
      } else {
        target = dir < 0 ? sel.from : sel.to;
      }
      extendSelection(this.doc, target, target, dir);
      if (goal != null) sel.goalColumn = goal;
    }),

    toggleOverwrite: function(value) {
      if (value != null && value == this.state.overwrite) return;
      if (this.state.overwrite = !this.state.overwrite)
        this.display.cursor.className += " CodeMirror-overwrite";
      else
        this.display.cursor.className = this.display.cursor.className.replace(" CodeMirror-overwrite", "");

      signal(this, "overwriteToggle", this, this.state.overwrite);
    },
    hasFocus: function() { return document.activeElement == this.display.input; },

    scrollTo: operation(null, function(x, y) {
      updateScrollPos(this, x, y);
    }),
    getScrollInfo: function() {
      var scroller = this.display.scroller, co = scrollerCutOff;
      return {left: scroller.scrollLeft, top: scroller.scrollTop,
              height: scroller.scrollHeight - co, width: scroller.scrollWidth - co,
              clientHeight: scroller.clientHeight - co, clientWidth: scroller.clientWidth - co};
    },

    scrollIntoView: operation(null, function(range, margin) {
      if (range == null) range = {from: this.doc.sel.head, to: null};
      else if (typeof range == "number") range = {from: Pos(range, 0), to: null};
      else if (range.from == null) range = {from: range, to: null};
      if (!range.to) range.to = range.from;
      if (!margin) margin = 0;

      var coords = range;
      if (range.from.line != null) {
        this.curOp.scrollToPos = {from: range.from, to: range.to, margin: margin};
        coords = {from: cursorCoords(this, range.from),
                  to: cursorCoords(this, range.to)};
      }
      var sPos = calculateScrollPos(this, Math.min(coords.from.left, coords.to.left),
                                    Math.min(coords.from.top, coords.to.top) - margin,
                                    Math.max(coords.from.right, coords.to.right),
                                    Math.max(coords.from.bottom, coords.to.bottom) + margin);
      updateScrollPos(this, sPos.scrollLeft, sPos.scrollTop);
    }),

    setSize: operation(null, function(width, height) {
      function interpret(val) {
        return typeof val == "number" || /^\d+$/.test(String(val)) ? val + "px" : val;
      }
      if (width != null) this.display.wrapper.style.width = interpret(width);
      if (height != null) this.display.wrapper.style.height = interpret(height);
      if (this.options.lineWrapping)
        this.display.measureLineCache.length = this.display.measureLineCachePos = 0;
      this.curOp.forceUpdate = true;
      signal(this, "refresh", this);
    }),

    operation: function(f){return runInOp(this, f);},

    refresh: operation(null, function() {
      var oldHeight = this.display.cachedTextHeight;
      clearCaches(this);
      updateScrollPos(this, this.doc.scrollLeft, this.doc.scrollTop);
      regChange(this);
      if (oldHeight == null || Math.abs(oldHeight - textHeight(this.display)) > .5)
        estimateLineHeights(this);
      signal(this, "refresh", this);
    }),

    swapDoc: operation(null, function(doc) {
      var old = this.doc;
      old.cm = null;
      attachDoc(this, doc);
      clearCaches(this);
      resetInput(this, true);
      updateScrollPos(this, doc.scrollLeft, doc.scrollTop);
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

  var optionHandlers = CodeMirror.optionHandlers = {};

  // The default configuration options.
  var defaults = CodeMirror.defaults = {};

  function option(name, deflt, handle, notOnInit) {
    CodeMirror.defaults[name] = deflt;
    if (handle) optionHandlers[name] =
      notOnInit ? function(cm, val, old) {if (old != Init) handle(cm, val, old);} : handle;
  }

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

  option("onKeyEvent", null);
  option("onDragEvent", null);

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
      if (!val) resetInput(cm, true);
    }
  });
  option("disableInput", false, function(cm, val) {if (!val) resetInput(cm, true);}, true);
  option("dragDrop", true);

  option("cursorBlinkRate", 530);
  option("cursorScrollMargin", 0);
  option("cursorHeight", 1);
  option("workTime", 100);
  option("workDelay", 100);
  option("flattenSpans", true, resetModeState, true);
  option("addModeClass", false, resetModeState, true);
  option("pollInterval", 100);
  option("undoDepth", 40, function(cm, val){cm.doc.history.undoDepth = val;});
  option("historyEventDelay", 500);
  option("viewportMargin", 10, function(cm){cm.refresh();}, true);
  option("maxHighlightLength", 10000, resetModeState, true);
  option("crudeMeasuringFrom", 10000);
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

  CodeMirror.defineMode("null", function() {
    return {token: function(stream) {stream.skipToEnd();}};
  });
  CodeMirror.defineMIME("text/plain", "null");

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

  // UTILITIES

  CodeMirror.isWordChar = isWordChar;

  // MODE STATE HANDLING

  // Utility functions for working with state. Exported because modes
  // sometimes need to do this.
  function copyState(mode, state) {
    if (state === true) return state;
    if (mode.copyState) return mode.copyState(state);
    var nstate = {};
    for (var n in state) {
      var val = state[n];
      if (val instanceof Array) val = val.concat([]);
      nstate[n] = val;
    }
    return nstate;
  }
  CodeMirror.copyState = copyState;

  function startState(mode, a1, a2) {
    return mode.startState ? mode.startState(a1, a2) : true;
  }
  CodeMirror.startState = startState;

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

  var commands = CodeMirror.commands = {
    selectAll: function(cm) {cm.setSelection(Pos(cm.firstLine(), 0), Pos(cm.lastLine()));},
    killLine: function(cm) {
      var from = cm.getCursor(true), to = cm.getCursor(false), sel = !posEq(from, to);
      if (!sel && cm.getLine(from.line).length == from.ch)
        cm.replaceRange("", from, Pos(from.line + 1, 0), "+delete");
      else cm.replaceRange("", from, sel ? to : Pos(from.line), "+delete");
    },
    deleteLine: function(cm) {
      var l = cm.getCursor().line;
      cm.replaceRange("", Pos(l, 0), Pos(l + 1, 0), "+delete");
    },
    delLineLeft: function(cm) {
      var cur = cm.getCursor();
      cm.replaceRange("", Pos(cur.line, 0), cur, "+delete");
    },
    undo: function(cm) {cm.undo();},
    redo: function(cm) {cm.redo();},
    goDocStart: function(cm) {cm.extendSelection(Pos(cm.firstLine(), 0));},
    goDocEnd: function(cm) {cm.extendSelection(Pos(cm.lastLine()));},
    goLineStart: function(cm) {
      cm.extendSelection(lineStart(cm, cm.getCursor().line));
    },
    goLineStartSmart: function(cm) {
      var cur = cm.getCursor(), start = lineStart(cm, cur.line);
      var line = cm.getLineHandle(start.line);
      var order = getOrder(line);
      if (!order || order[0].level == 0) {
        var firstNonWS = Math.max(0, line.text.search(/\S/));
        var inWS = cur.line == start.line && cur.ch <= firstNonWS && cur.ch;
        cm.extendSelection(Pos(start.line, inWS ? 0 : firstNonWS));
      } else cm.extendSelection(start);
    },
    goLineEnd: function(cm) {
      cm.extendSelection(lineEnd(cm, cm.getCursor().line));
    },
    goLineRight: function(cm) {
      var top = cm.charCoords(cm.getCursor(), "div").top + 5;
      cm.extendSelection(cm.coordsChar({left: cm.display.lineDiv.offsetWidth + 100, top: top}, "div"));
    },
    goLineLeft: function(cm) {
      var top = cm.charCoords(cm.getCursor(), "div").top + 5;
      cm.extendSelection(cm.coordsChar({left: 0, top: top}, "div"));
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
    insertTab: function(cm) {
      cm.replaceSelection("\t", "end", "+input");
    },
    defaultTab: function(cm) {
      if (cm.somethingSelected()) cm.indentSelection("add");
      else cm.replaceSelection("\t", "end", "+input");
    },
    transposeChars: function(cm) {
      var cur = cm.getCursor(), line = cm.getLine(cur.line);
      if (cur.ch > 0 && cur.ch < line.length - 1)
        cm.replaceRange(line.charAt(cur.ch) + line.charAt(cur.ch - 1),
                        Pos(cur.line, cur.ch - 1), Pos(cur.line, cur.ch + 1));
    },
    newlineAndIndent: function(cm) {
      operation(cm, function() {
        cm.replaceSelection("\n", "end", "+input");
        cm.indentLine(cm.getCursor().line, null, true);
      })();
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
    "Enter": "newlineAndIndent", "Insert": "toggleOverwrite"
  };
  // Note that the save and find-related commands aren't defined by
  // default. Unknown commands are simply ignored.
  keyMap.pcDefault = {
    "Ctrl-A": "selectAll", "Ctrl-D": "deleteLine", "Ctrl-Z": "undo", "Shift-Ctrl-Z": "redo", "Ctrl-Y": "redo",
    "Ctrl-Home": "goDocStart", "Ctrl-Up": "goDocStart", "Ctrl-End": "goDocEnd", "Ctrl-Down": "goDocEnd",
    "Ctrl-Left": "goGroupLeft", "Ctrl-Right": "goGroupRight", "Alt-Left": "goLineStart", "Alt-Right": "goLineEnd",
    "Ctrl-Backspace": "delGroupBefore", "Ctrl-Delete": "delGroupAfter", "Ctrl-S": "save", "Ctrl-F": "find",
    "Ctrl-G": "findNext", "Shift-Ctrl-G": "findPrev", "Shift-Ctrl-F": "replace", "Shift-Ctrl-R": "replaceAll",
    "Ctrl-[": "indentLess", "Ctrl-]": "indentMore",
    fallthrough: "basic"
  };
  keyMap.macDefault = {
    "Cmd-A": "selectAll", "Cmd-D": "deleteLine", "Cmd-Z": "undo", "Shift-Cmd-Z": "redo", "Cmd-Y": "redo",
    "Cmd-Up": "goDocStart", "Cmd-End": "goDocEnd", "Cmd-Down": "goDocEnd", "Alt-Left": "goGroupLeft",
    "Alt-Right": "goGroupRight", "Cmd-Left": "goLineStart", "Cmd-Right": "goLineEnd", "Alt-Backspace": "delGroupBefore",
    "Ctrl-Alt-Backspace": "delGroupAfter", "Alt-Delete": "delGroupAfter", "Cmd-S": "save", "Cmd-F": "find",
    "Cmd-G": "findNext", "Shift-Cmd-G": "findPrev", "Cmd-Alt-F": "replace", "Shift-Cmd-Alt-F": "replaceAll",
    "Cmd-[": "indentLess", "Cmd-]": "indentMore", "Cmd-Backspace": "delLineLeft",
    fallthrough: ["basic", "emacsy"]
  };
  keyMap["default"] = mac ? keyMap.macDefault : keyMap.pcDefault;
  keyMap.emacsy = {
    "Ctrl-F": "goCharRight", "Ctrl-B": "goCharLeft", "Ctrl-P": "goLineUp", "Ctrl-N": "goLineDown",
    "Alt-F": "goWordRight", "Alt-B": "goWordLeft", "Ctrl-A": "goLineStart", "Ctrl-E": "goLineEnd",
    "Ctrl-V": "goPageDown", "Shift-Ctrl-V": "goPageUp", "Ctrl-D": "delCharAfter", "Ctrl-H": "delCharBefore",
    "Alt-D": "delWordAfter", "Alt-Backspace": "delWordBefore", "Ctrl-K": "killLine", "Ctrl-T": "transposeChars"
  };

  // KEYMAP DISPATCH

  function getKeyMap(val) {
    if (typeof val == "string") return keyMap[val];
    else return val;
  }

  function lookupKey(name, maps, handle) {
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
      for (var i = 0, e = fallthrough.length; i < e; ++i) {
        var done = lookup(fallthrough[i]);
        if (done) return done;
      }
      return false;
    }

    for (var i = 0; i < maps.length; ++i) {
      var done = lookup(maps[i]);
      if (done) return done != "stop";
    }
  }
  function isModifierKey(event) {
    var name = keyNames[event.keyCode];
    return name == "Ctrl" || name == "Alt" || name == "Shift" || name == "Mod";
  }
  function keyName(event, noShift) {
    if (opera && event.keyCode == 34 && event["char"]) return false;
    var name = keyNames[event.keyCode];
    if (name == null || event.altGraphKey) return false;
    if (event.altKey) name = "Alt-" + name;
    if (flipCtrlCmd ? event.metaKey : event.ctrlKey) name = "Ctrl-" + name;
    if (flipCtrlCmd ? event.ctrlKey : event.metaKey) name = "Cmd-" + name;
    if (!noShift && event.shiftKey) name = "Shift-" + name;
    return name;
  }
  CodeMirror.lookupKey = lookupKey;
  CodeMirror.isModifierKey = isModifierKey;
  CodeMirror.keyName = keyName;

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
      var hasFocus = document.body;
      // doc.activeElement occasionally throws on IE
      try { hasFocus = document.activeElement; } catch(e) {}
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

  // The character stream used by a mode's parser.
  function StringStream(string, tabSize) {
    this.pos = this.start = 0;
    this.string = string;
    this.tabSize = tabSize || 8;
    this.lastColumnPos = this.lastColumnValue = 0;
    this.lineStart = 0;
  }

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
  CodeMirror.StringStream = StringStream;

  // TEXTMARKERS

  function TextMarker(doc, type) {
    this.lines = [];
    this.type = type;
    this.doc = doc;
  }
  CodeMirror.TextMarker = TextMarker;
  eventMixin(TextMarker);

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
      if (span.to != null) max = lineNo(line);
      line.markedSpans = removeMarkedSpan(line.markedSpans, span);
      if (span.from != null)
        min = lineNo(line);
      else if (this.collapsed && !lineIsHidden(this.doc, line) && cm)
        updateLineHeight(line, textHeight(cm.display));
    }
    if (cm && this.collapsed && !cm.options.lineWrapping) for (var i = 0; i < this.lines.length; ++i) {
      var visual = visualLine(cm.doc, this.lines[i]), len = lineLength(cm.doc, visual);
      if (len > cm.display.maxLineLength) {
        cm.display.maxLine = visual;
        cm.display.maxLineLength = len;
        cm.display.maxLineChanged = true;
      }
    }

    if (min != null && cm) regChange(cm, min, max + 1);
    this.lines.length = 0;
    this.explicitlyCleared = true;
    if (this.atomic && this.doc.cantEdit) {
      this.doc.cantEdit = false;
      if (cm) reCheckSelection(cm);
    }
    if (withOp) endOperation(cm);
  };

  TextMarker.prototype.find = function(bothSides) {
    var from, to;
    for (var i = 0; i < this.lines.length; ++i) {
      var line = this.lines[i];
      var span = getMarkedSpanFor(line.markedSpans, this);
      if (span.from != null || span.to != null) {
        var found = lineNo(line);
        if (span.from != null) from = Pos(found, span.from);
        if (span.to != null) to = Pos(found, span.to);
      }
    }
    if (this.type == "bookmark" && !bothSides) return from;
    return from && {from: from, to: to};
  };

  TextMarker.prototype.changed = function() {
    var pos = this.find(), cm = this.doc.cm;
    if (!pos || !cm) return;
    if (this.type != "bookmark") pos = pos.from;
    var line = getLine(this.doc, pos.line);
    clearCachedMeasurement(cm, line);
    if (pos.line >= cm.display.showingFrom && pos.line < cm.display.showingTo) {
      for (var node = cm.display.lineDiv.firstChild; node; node = node.nextSibling) if (node.lineObj == line) {
        if (node.offsetHeight != line.height) updateLineHeight(line, node.offsetHeight);
        break;
      }
      runInOp(cm, function() {
        cm.curOp.selectionChanged = cm.curOp.forceUpdate = cm.curOp.updateMaxLine = true;
      });
    }
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

  var nextMarkerId = 0;

  function markText(doc, from, to, options, type) {
    if (options && options.shared) return markTextShared(doc, from, to, options, type);
    if (doc.cm && !doc.cm.curOp) return operation(doc.cm, markText)(doc, from, to, options, type);

    var marker = new TextMarker(doc, type);
    if (options) copyObj(options, marker);
    if (posLess(to, from) || posEq(from, to) && marker.clearWhenEmpty !== false)
      return marker;
    if (marker.replacedWith) {
      marker.collapsed = true;
      marker.replacedWith = elt("span", [marker.replacedWith], "CodeMirror-widget");
      if (!options.handleMouseEvents) marker.replacedWith.ignoreEvents = true;
    }
    if (marker.collapsed) {
      if (conflictingCollapsedRange(doc, from.line, from, to, marker) ||
          from.line != to.line && conflictingCollapsedRange(doc, to.line, from, to, marker))
        throw new Error("Inserting collapsed marker partially overlapping an existing one");
      sawCollapsedSpans = true;
    }

    if (marker.addToHistory)
      addToHistory(doc, {from: from, to: to, origin: "markText"},
                   {head: doc.sel.head, anchor: doc.sel.anchor}, NaN);

    var curLine = from.line, cm = doc.cm, updateMaxLine;
    doc.iter(curLine, to.line + 1, function(line) {
      if (cm && marker.collapsed && !cm.options.lineWrapping && visualLine(doc, line) == cm.display.maxLine)
        updateMaxLine = true;
      var span = {from: null, to: null, marker: marker};
      if (curLine == from.line) span.from = from.ch;
      if (curLine == to.line) span.to = to.ch;
      if (marker.collapsed && curLine != from.line) updateLineHeight(line, 0);
      addMarkedSpan(line, span);
      ++curLine;
    });
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
      if (updateMaxLine) cm.curOp.updateMaxLine = true;
      if (marker.className || marker.title || marker.startStyle || marker.endStyle || marker.collapsed)
        regChange(cm, from.line, to.line + 1);
      if (marker.atomic) reCheckSelection(cm);
    }
    return marker;
  }

  // SHARED TEXTMARKERS

  function SharedTextMarker(markers, primary) {
    this.markers = markers;
    this.primary = primary;
    for (var i = 0, me = this; i < markers.length; ++i) {
      markers[i].parent = this;
      on(markers[i], "clear", function(){me.clear();});
    }
  }
  CodeMirror.SharedTextMarker = SharedTextMarker;
  eventMixin(SharedTextMarker);

  SharedTextMarker.prototype.clear = function() {
    if (this.explicitlyCleared) return;
    this.explicitlyCleared = true;
    for (var i = 0; i < this.markers.length; ++i)
      this.markers[i].clear();
    signalLater(this, "clear");
  };
  SharedTextMarker.prototype.find = function() {
    return this.primary.find();
  };

  function markTextShared(doc, from, to, options, type) {
    options = copyObj(options);
    options.shared = false;
    var markers = [markText(doc, from, to, options, type)], primary = markers[0];
    var widget = options.replacedWith;
    linkedDocs(doc, function(doc) {
      if (widget) options.replacedWith = widget.cloneNode(true);
      markers.push(markText(doc, clipPos(doc, from), clipPos(doc, to), options, type));
      for (var i = 0; i < doc.linked.length; ++i)
        if (doc.linked[i].isParent) return;
      primary = lst(markers);
    });
    return new SharedTextMarker(markers, primary);
  }

  // TEXTMARKER SPANS

  function getMarkedSpanFor(spans, marker) {
    if (spans) for (var i = 0; i < spans.length; ++i) {
      var span = spans[i];
      if (span.marker == marker) return span;
    }
  }
  function removeMarkedSpan(spans, span) {
    for (var r, i = 0; i < spans.length; ++i)
      if (spans[i] != span) (r || (r = [])).push(spans[i]);
    return r;
  }
  function addMarkedSpan(line, span) {
    line.markedSpans = line.markedSpans ? line.markedSpans.concat([span]) : [span];
    span.marker.attachLine(line);
  }

  function markedSpansBefore(old, startCh, isInsert) {
    if (old) for (var i = 0, nw; i < old.length; ++i) {
      var span = old[i], marker = span.marker;
      var startsBefore = span.from == null || (marker.inclusiveLeft ? span.from <= startCh : span.from < startCh);
      if (startsBefore || span.from == startCh && marker.type == "bookmark" && (!isInsert || !span.marker.insertLeft)) {
        var endsAfter = span.to == null || (marker.inclusiveRight ? span.to >= startCh : span.to > startCh);
        (nw || (nw = [])).push({from: span.from,
                                to: endsAfter ? null : span.to,
                                marker: marker});
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
        (nw || (nw = [])).push({from: startsBefore ? null : span.from - endCh,
                                to: span.to == null ? null : span.to - endCh,
                                marker: marker});
      }
    }
    return nw;
  }

  function stretchSpansOverChange(doc, change) {
    var oldFirst = isLine(doc, change.from.line) && getLine(doc, change.from.line).markedSpans;
    var oldLast = isLine(doc, change.to.line) && getLine(doc, change.to.line).markedSpans;
    if (!oldFirst && !oldLast) return null;

    var startCh = change.from.ch, endCh = change.to.ch, isInsert = posEq(change.from, change.to);
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
            (gapMarkers || (gapMarkers = [])).push({from: null, to: null, marker: first[i].marker});
      for (var i = 0; i < gap; ++i)
        newMarkers.push(gapMarkers);
      newMarkers.push(last);
    }
    return newMarkers;
  }

  function clearEmptySpans(spans) {
    for (var i = 0; i < spans.length; ++i) {
      var span = spans[i];
      if (span.from != null && span.from == span.to && span.marker.clearWhenEmpty !== false)
        spans.splice(i--, 1);
    }
    if (!spans.length) return null;
    return spans;
  }

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
      var mk = markers[i], m = mk.find();
      for (var j = 0; j < parts.length; ++j) {
        var p = parts[j];
        if (posLess(p.to, m.from) || posLess(m.to, p.from)) continue;
        var newParts = [j, 1];
        if (posLess(p.from, m.from) || !mk.inclusiveLeft && posEq(p.from, m.from))
          newParts.push({from: p.from, to: m.from});
        if (posLess(m.to, p.to) || !mk.inclusiveRight && posEq(p.to, m.to))
          newParts.push({from: m.to, to: p.to});
        parts.splice.apply(parts, newParts);
        j += newParts.length - 1;
      }
    }
    return parts;
  }

  function extraLeft(marker) { return marker.inclusiveLeft ? -1 : 0; }
  function extraRight(marker) { return marker.inclusiveRight ? 1 : 0; }

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

  function conflictingCollapsedRange(doc, lineNo, from, to, marker) {
    var line = getLine(doc, lineNo);
    var sps = sawCollapsedSpans && line.markedSpans;
    if (sps) for (var i = 0; i < sps.length; ++i) {
      var sp = sps[i];
      if (!sp.marker.collapsed) continue;
      var found = sp.marker.find(true);
      var fromCmp = cmp(found.from, from) || extraLeft(sp.marker) - extraLeft(marker);
      var toCmp = cmp(found.to, to) || extraRight(sp.marker) - extraRight(marker);
      if (fromCmp >= 0 && toCmp <= 0 || fromCmp <= 0 && toCmp >= 0) continue;
      if (fromCmp <= 0 && (cmp(found.to, from) || extraRight(sp.marker) - extraLeft(marker)) > 0 ||
          fromCmp >= 0 && (cmp(found.from, to) || extraLeft(sp.marker) - extraRight(marker)) < 0)
        return true;
    }
  }

  function visualLine(doc, line) {
    var merged;
    while (merged = collapsedSpanAtStart(line))
      line = getLine(doc, merged.find().from.line);
    return line;
  }

  function lineIsHidden(doc, line) {
    var sps = sawCollapsedSpans && line.markedSpans;
    if (sps) for (var sp, i = 0; i < sps.length; ++i) {
      sp = sps[i];
      if (!sp.marker.collapsed) continue;
      if (sp.from == null) return true;
      if (sp.marker.replacedWith) continue;
      if (sp.from == 0 && sp.marker.inclusiveLeft && lineIsHiddenInner(doc, line, sp))
        return true;
    }
  }
  function lineIsHiddenInner(doc, line, span) {
    if (span.to == null) {
      var end = span.marker.find().to, endLine = getLine(doc, end.line);
      return lineIsHiddenInner(doc, endLine, getMarkedSpanFor(endLine.markedSpans, span.marker));
    }
    if (span.marker.inclusiveRight && span.to == line.text.length)
      return true;
    for (var sp, i = 0; i < line.markedSpans.length; ++i) {
      sp = line.markedSpans[i];
      if (sp.marker.collapsed && !sp.marker.replacedWith && sp.from == span.to &&
          (sp.to == null || sp.to != span.from) &&
          (sp.marker.inclusiveLeft || span.marker.inclusiveRight) &&
          lineIsHiddenInner(doc, line, sp)) return true;
    }
  }

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

  // LINE WIDGETS

  var LineWidget = CodeMirror.LineWidget = function(cm, node, options) {
    if (options) for (var opt in options) if (options.hasOwnProperty(opt))
      this[opt] = options[opt];
    this.cm = cm;
    this.node = node;
  };
  eventMixin(LineWidget);
  function widgetOperation(f) {
    return function() {
      var withOp = !this.cm.curOp;
      if (withOp) startOperation(this.cm);
      try {var result = f.apply(this, arguments);}
      finally {if (withOp) endOperation(this.cm);}
      return result;
    };
  }
  LineWidget.prototype.clear = widgetOperation(function() {
    var ws = this.line.widgets, no = lineNo(this.line);
    if (no == null || !ws) return;
    for (var i = 0; i < ws.length; ++i) if (ws[i] == this) ws.splice(i--, 1);
    if (!ws.length) this.line.widgets = null;
    var aboveVisible = heightAtLine(this.cm, this.line) < this.cm.doc.scrollTop;
    updateLineHeight(this.line, Math.max(0, this.line.height - widgetHeight(this)));
    if (aboveVisible) addToScrollPos(this.cm, 0, -this.height);
    regChange(this.cm, no, no + 1);
  });
  LineWidget.prototype.changed = widgetOperation(function() {
    var oldH = this.height;
    this.height = null;
    var diff = widgetHeight(this) - oldH;
    if (!diff) return;
    updateLineHeight(this.line, this.line.height + diff);
    var no = lineNo(this.line);
    regChange(this.cm, no, no + 1);
  });

  function widgetHeight(widget) {
    if (widget.height != null) return widget.height;
    if (!widget.node.parentNode || widget.node.parentNode.nodeType != 1)
      removeChildrenAndAdd(widget.cm.display.measure, elt("div", [widget.node], null, "position: relative"));
    return widget.height = widget.node.offsetHeight;
  }

  function addLineWidget(cm, handle, node, options) {
    var widget = new LineWidget(cm, node, options);
    if (widget.noHScroll) cm.display.alignWidgets = true;
    changeLine(cm, handle, function(line) {
      var widgets = line.widgets || (line.widgets = []);
      if (widget.insertAt == null) widgets.push(widget);
      else widgets.splice(Math.min(widgets.length - 1, Math.max(0, widget.insertAt)), 0, widget);
      widget.line = line;
      if (!lineIsHidden(cm.doc, line) || widget.showIfHidden) {
        var aboveVisible = heightAtLine(cm, line) < cm.doc.scrollTop;
        updateLineHeight(line, line.height + widgetHeight(widget));
        if (aboveVisible) addToScrollPos(cm, 0, widget.height);
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

  function cleanUpLine(line) {
    line.parent = null;
    detachMarkedSpans(line);
  }

  // Run the given mode's parser over a line, update the styles
  // array, which contains alternating fragments of text and CSS
  // classes.
  function runMode(cm, text, mode, state, f, forceToEnd) {
    var flattenSpans = mode.flattenSpans;
    if (flattenSpans == null) flattenSpans = cm.options.flattenSpans;
    var curStart = 0, curStyle = null;
    var stream = new StringStream(text, cm.options.tabSize), style;
    if (text == "" && mode.blankLine) mode.blankLine(state);
    while (!stream.eol()) {
      if (stream.pos > cm.options.maxHighlightLength) {
        flattenSpans = false;
        if (forceToEnd) processLine(cm, text, state, stream.pos);
        stream.pos = text.length;
        style = null;
      } else {
        style = mode.token(stream, state);
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

  function highlightLine(cm, line, state, forceToEnd) {
    // A styles array always starts with a number identifying the
    // mode/overlays that it is based on (for easy invalidation).
    var st = [cm.state.modeGen];
    // Compute the base array of styles
    runMode(cm, line.text, cm.doc.mode, state, function(end, style) {
      st.push(end, style);
    }, forceToEnd);

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
          st.splice(start, i - start, end, style);
          i = start + 2;
        } else {
          for (; start < i; start += 2) {
            var cur = st[start+1];
            st[start+1] = cur ? cur + " " + style : style;
          }
        }
      });
    }

    return st;
  }

  function getLineStyles(cm, line) {
    if (!line.styles || line.styles[0] != cm.state.modeGen)
      line.styles = highlightLine(cm, line, line.stateAfter = getStateBefore(cm, lineNo(line)));
    return line.styles;
  }

  // Lightweight form of highlight -- proceed over this line and
  // update state, but don't save a style array.
  function processLine(cm, text, state, startAt) {
    var mode = cm.doc.mode;
    var stream = new StringStream(text, cm.options.tabSize);
    stream.start = stream.pos = startAt || 0;
    if (text == "" && mode.blankLine) mode.blankLine(state);
    while (!stream.eol() && stream.pos <= cm.options.maxHighlightLength) {
      mode.token(stream, state);
      stream.start = stream.pos;
    }
  }

  var styleToClassCache = {}, styleToClassCacheWithMode = {};
  function interpretTokenStyle(style, builder) {
    if (!style) return null;
    for (;;) {
      var lineClass = style.match(/(?:^|\s+)line-(background-)?(\S+)/);
      if (!lineClass) break;
      style = style.slice(0, lineClass.index) + style.slice(lineClass.index + lineClass[0].length);
      var prop = lineClass[1] ? "bgClass" : "textClass";
      if (builder[prop] == null)
        builder[prop] = lineClass[2];
      else if (!(new RegExp("(?:^|\s)" + lineClass[2] + "(?:$|\s)")).test(builder[prop]))
        builder[prop] += " " + lineClass[2];
    }
    if (/^\s*$/.test(style)) return null;
    var cache = builder.cm.options.addModeClass ? styleToClassCacheWithMode : styleToClassCache;
    return cache[style] ||
      (cache[style] = style.replace(/\S+/g, "cm-$&"));
  }

  function buildLineContent(cm, realLine, measure, copyWidgets) {
    var merged, line = realLine, empty = true;
    while (merged = collapsedSpanAtStart(line))
      line = getLine(cm.doc, merged.find().from.line);

    var builder = {pre: elt("pre"), col: 0, pos: 0,
                   measure: null, measuredSomething: false, cm: cm,
                   copyWidgets: copyWidgets};

    do {
      if (line.text) empty = false;
      builder.measure = line == realLine && measure;
      builder.pos = 0;
      builder.addToken = builder.measure ? buildTokenMeasure : buildToken;
      if ((ie || webkit) && cm.getOption("lineWrapping"))
        builder.addToken = buildTokenSplitSpaces(builder.addToken);
      var next = insertLineContent(line, builder, getLineStyles(cm, line));
      if (measure && line == realLine && !builder.measuredSomething) {
        measure[0] = builder.pre.appendChild(zeroWidthElement(cm.display.measure));
        builder.measuredSomething = true;
      }
      if (next) line = getLine(cm.doc, next.to.line);
    } while (next);

    if (measure && !builder.measuredSomething && !measure[0])
      measure[0] = builder.pre.appendChild(empty ? elt("span", "\u00a0") : zeroWidthElement(cm.display.measure));
    if (!builder.pre.firstChild && !lineIsHidden(cm.doc, realLine))
      builder.pre.appendChild(document.createTextNode("\u00a0"));

    var order;
    // Work around problem with the reported dimensions of single-char
    // direction spans on IE (issue #1129). See also the comment in
    // cursorCoords.
    if (measure && ie && (order = getOrder(line))) {
      var l = order.length - 1;
      if (order[l].from == order[l].to) --l;
      var last = order[l], prev = order[l - 1];
      if (last.from + 1 == last.to && prev && last.level < prev.level) {
        var span = measure[builder.pos - 1];
        if (span) span.parentNode.insertBefore(span.measureRight = zeroWidthElement(cm.display.measure),
                                               span.nextSibling);
      }
    }

    var textClass = builder.textClass ? builder.textClass + " " + (realLine.textClass || "") : realLine.textClass;
    if (textClass) builder.pre.className = textClass;

    signal(cm, "renderLine", cm, realLine, builder.pre);
    return builder;
  }

  function defaultSpecialCharPlaceholder(ch) {
    var token = elt("span", "\u2022", "cm-invalidchar");
    token.title = "\\u" + ch.charCodeAt(0).toString(16);
    return token;
  }

  function buildToken(builder, text, style, startStyle, endStyle, title) {
    if (!text) return;
    var special = builder.cm.options.specialChars;
    if (!special.test(text)) {
      builder.col += text.length;
      var content = document.createTextNode(text);
    } else {
      var content = document.createDocumentFragment(), pos = 0;
      while (true) {
        special.lastIndex = pos;
        var m = special.exec(text);
        var skipped = m ? m.index - pos : text.length - pos;
        if (skipped) {
          content.appendChild(document.createTextNode(text.slice(pos, pos + skipped)));
          builder.col += skipped;
        }
        if (!m) break;
        pos += skipped + 1;
        if (m[0] == "\t") {
          var tabSize = builder.cm.options.tabSize, tabWidth = tabSize - builder.col % tabSize;
          content.appendChild(elt("span", spaceStr(tabWidth), "cm-tab"));
          builder.col += tabWidth;
        } else {
          var token = builder.cm.options.specialCharPlaceholder(m[0]);
          content.appendChild(token);
          builder.col += 1;
        }
      }
    }
    if (style || startStyle || endStyle || builder.measure) {
      var fullStyle = style || "";
      if (startStyle) fullStyle += startStyle;
      if (endStyle) fullStyle += endStyle;
      var token = elt("span", [content], fullStyle);
      if (title) token.title = title;
      return builder.pre.appendChild(token);
    }
    builder.pre.appendChild(content);
  }

  function buildTokenMeasure(builder, text, style, startStyle, endStyle) {
    var wrapping = builder.cm.options.lineWrapping;
    for (var i = 0; i < text.length; ++i) {
      var start = i == 0, to = i + 1;
      while (to < text.length && isExtendingChar(text.charAt(to))) ++to;
      var ch = text.slice(i, to);
      i = to - 1;
      if (i && wrapping && spanAffectsWrapping(text, i))
        builder.pre.appendChild(elt("wbr"));
      var old = builder.measure[builder.pos];
      var span = builder.measure[builder.pos] =
        buildToken(builder, ch, style,
                   start && startStyle, i == text.length - 1 && endStyle);
      if (old) span.leftSide = old.leftSide || old;
      // In IE single-space nodes wrap differently than spaces
      // embedded in larger text nodes, except when set to
      // white-space: normal (issue #1268).
      if (old_ie && wrapping && ch == " " && i && !/\s/.test(text.charAt(i - 1)) &&
          i < text.length - 1 && !/\s/.test(text.charAt(i + 1)))
        span.style.whiteSpace = "normal";
      builder.pos += ch.length;
    }
    if (text.length) builder.measuredSomething = true;
  }

  function buildTokenSplitSpaces(inner) {
    function split(old) {
      var out = " ";
      for (var i = 0; i < old.length - 2; ++i) out += i % 2 ? " " : "\u00a0";
      out += " ";
      return out;
    }
    return function(builder, text, style, startStyle, endStyle, title) {
      return inner(builder, text.replace(/ {3,}/g, split), style, startStyle, endStyle, title);
    };
  }

  function buildCollapsedSpan(builder, size, marker, ignoreWidget) {
    var widget = !ignoreWidget && marker.replacedWith;
    if (widget) {
      if (builder.copyWidgets) widget = widget.cloneNode(true);
      builder.pre.appendChild(widget);
      if (builder.measure) {
        if (size) {
          builder.measure[builder.pos] = widget;
        } else {
          var elt = zeroWidthElement(builder.cm.display.measure);
          if (marker.type == "bookmark" && !marker.insertLeft)
            builder.measure[builder.pos] = builder.pre.appendChild(elt);
          else if (builder.measure[builder.pos])
            return;
          else
            builder.measure[builder.pos] = builder.pre.insertBefore(elt, widget);
        }
        builder.measuredSomething = true;
      }
    }
    builder.pos += size;
  }

  // Outputs a number of spans to make up a line, taking highlighting
  // and marked text into account.
  function insertLineContent(line, builder, styles) {
    var spans = line.markedSpans, allText = line.text, at = 0;
    if (!spans) {
      for (var i = 1; i < styles.length; i+=2)
        builder.addToken(builder, allText.slice(at, at = styles[i]), interpretTokenStyle(styles[i+1], builder));
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
          if (m.type == "bookmark" && sp.from == pos && m.replacedWith) foundBookmarks.push(m);
        }
        if (collapsed && (collapsed.from || 0) == pos) {
          buildCollapsedSpan(builder, (collapsed.to == null ? len : collapsed.to) - pos,
                             collapsed.marker, collapsed.from == null);
          if (collapsed.to == null) return collapsed.marker.find();
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
        style = interpretTokenStyle(styles[i++], builder);
      }
    }
  }

  // DOCUMENT DATA STRUCTURE

  function updateDoc(doc, change, markedSpans, selAfter, estimateHeight) {
    function spansFor(n) {return markedSpans ? markedSpans[n] : null;}
    function update(line, text, spans) {
      updateLine(line, text, spans, estimateHeight);
      signalLater(line, "change", line, change);
    }

    var from = change.from, to = change.to, text = change.text;
    var firstLine = getLine(doc, from.line), lastLine = getLine(doc, to.line);
    var lastText = lst(text), lastSpans = spansFor(text.length - 1), nlines = to.line - from.line;

    // First adjust the line structure
    if (from.ch == 0 && to.ch == 0 && lastText == "" &&
        (!doc.cm || doc.cm.options.wholeLineUpdateBefore)) {
      // This is a whole-line replace. Treated specially to make
      // sure line objects move the way they are supposed to.
      for (var i = 0, e = text.length - 1, added = []; i < e; ++i)
        added.push(new Line(text[i], spansFor(i), estimateHeight));
      update(lastLine, lastLine.text, lastSpans);
      if (nlines) doc.remove(from.line, nlines);
      if (added.length) doc.insert(from.line, added);
    } else if (firstLine == lastLine) {
      if (text.length == 1) {
        update(firstLine, firstLine.text.slice(0, from.ch) + lastText + firstLine.text.slice(to.ch), lastSpans);
      } else {
        for (var added = [], i = 1, e = text.length - 1; i < e; ++i)
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
      for (var i = 1, e = text.length - 1, added = []; i < e; ++i)
        added.push(new Line(text[i], spansFor(i), estimateHeight));
      if (nlines > 1) doc.remove(from.line + 1, nlines - 1);
      doc.insert(from.line + 1, added);
    }

    signalLater(doc, "change", doc, change);
    setSelection(doc, selAfter.anchor, selAfter.head, null, true);
  }

  function LeafChunk(lines) {
    this.lines = lines;
    this.parent = null;
    for (var i = 0, e = lines.length, height = 0; i < e; ++i) {
      lines[i].parent = this;
      height += lines[i].height;
    }
    this.height = height;
  }

  LeafChunk.prototype = {
    chunkSize: function() { return this.lines.length; },
    removeInner: function(at, n) {
      for (var i = at, e = at + n; i < e; ++i) {
        var line = this.lines[i];
        this.height -= line.height;
        cleanUpLine(line);
        signalLater(line, "delete");
      }
      this.lines.splice(at, n);
    },
    collapse: function(lines) {
      lines.splice.apply(lines, [lines.length, 0].concat(this.lines));
    },
    insertInner: function(at, lines, height) {
      this.height += height;
      this.lines = this.lines.slice(0, at).concat(lines).concat(this.lines.slice(at));
      for (var i = 0, e = lines.length; i < e; ++i) lines[i].parent = this;
    },
    iterN: function(at, n, op) {
      for (var e = at + n; at < e; ++at)
        if (op(this.lines[at])) return true;
    }
  };

  function BranchChunk(children) {
    this.children = children;
    var size = 0, height = 0;
    for (var i = 0, e = children.length; i < e; ++i) {
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
      if (this.size - n < 25) {
        var lines = [];
        this.collapse(lines);
        this.children = [new LeafChunk(lines)];
        this.children[0].parent = this;
      }
    },
    collapse: function(lines) {
      for (var i = 0, e = this.children.length; i < e; ++i) this.children[i].collapse(lines);
    },
    insertInner: function(at, lines, height) {
      this.size += lines.length;
      this.height += height;
      for (var i = 0, e = this.children.length; i < e; ++i) {
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
      for (var i = 0, e = this.children.length; i < e; ++i) {
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
    this.history = makeHistory();
    this.cleanGeneration = 1;
    this.frontier = firstLine;
    var start = Pos(firstLine, 0);
    this.sel = {from: start, to: start, head: start, anchor: start, shift: false, extend: false, goalColumn: null};
    this.id = ++nextDocId;
    this.modeOption = mode;

    if (typeof text == "string") text = splitLines(text);
    updateDoc(this, {from: start, to: start, text: text}, null, {head: start, anchor: start});
  };

  Doc.prototype = createObj(BranchChunk.prototype, {
    constructor: Doc,
    iter: function(from, to, op) {
      if (op) this.iterN(from - this.first, to - from, op);
      else this.iterN(this.first, this.first + this.size, from);
    },

    insert: function(at, lines) {
      var height = 0;
      for (var i = 0, e = lines.length; i < e; ++i) height += lines[i].height;
      this.insertInner(at - this.first, lines, height);
    },
    remove: function(at, n) { this.removeInner(at - this.first, n); },

    getValue: function(lineSep) {
      var lines = getLines(this, this.first, this.first + this.size);
      if (lineSep === false) return lines;
      return lines.join(lineSep || "\n");
    },
    setValue: function(code) {
      var top = Pos(this.first, 0), last = this.first + this.size - 1;
      makeChange(this, {from: top, to: Pos(last, getLine(this, last).text.length),
                        text: splitLines(code), origin: "setValue"},
                 {head: top, anchor: top}, true);
    },
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
    setLine: function(line, text) {
      if (isLine(this, line))
        replaceRange(this, text, Pos(line, 0), clipPos(this, Pos(line)));
    },
    removeLine: function(line) {
      if (line) replaceRange(this, "", clipPos(this, Pos(line - 1)), clipPos(this, Pos(line)));
      else replaceRange(this, "", Pos(0, 0), clipPos(this, Pos(1, 0)));
    },

    getLineHandle: function(line) {if (isLine(this, line)) return getLine(this, line);},
    getLineNumber: function(line) {return lineNo(line);},

    getLineHandleVisualStart: function(line) {
      if (typeof line == "number") line = getLine(this, line);
      return visualLine(this, line);
    },

    lineCount: function() {return this.size;},
    firstLine: function() {return this.first;},
    lastLine: function() {return this.first + this.size - 1;},

    clipPos: function(pos) {return clipPos(this, pos);},

    getCursor: function(start) {
      var sel = this.sel, pos;
      if (start == null || start == "head") pos = sel.head;
      else if (start == "anchor") pos = sel.anchor;
      else if (start == "end" || start === false) pos = sel.to;
      else pos = sel.from;
      return copyPos(pos);
    },
    somethingSelected: function() {return !posEq(this.sel.head, this.sel.anchor);},

    setCursor: docOperation(function(line, ch, extend) {
      var pos = clipPos(this, typeof line == "number" ? Pos(line, ch || 0) : line);
      if (extend) extendSelection(this, pos);
      else setSelection(this, pos, pos);
    }),
    setSelection: docOperation(function(anchor, head, bias) {
      setSelection(this, clipPos(this, anchor), clipPos(this, head || anchor), bias);
    }),
    extendSelection: docOperation(function(from, to, bias) {
      extendSelection(this, clipPos(this, from), to && clipPos(this, to), bias);
    }),

    getSelection: function(lineSep) {return this.getRange(this.sel.from, this.sel.to, lineSep);},
    replaceSelection: function(code, collapse, origin) {
      makeChange(this, {from: this.sel.from, to: this.sel.to, text: splitLines(code), origin: origin}, collapse || "around");
    },
    undo: docOperation(function() {makeChangeFromHistory(this, "undo");}),
    redo: docOperation(function() {makeChangeFromHistory(this, "redo");}),

    setExtending: function(val) {this.sel.extend = val;},

    historySize: function() {
      var hist = this.history;
      return {undo: hist.done.length, redo: hist.undone.length};
    },
    clearHistory: function() {this.history = makeHistory(this.history.maxGeneration);},

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
      var hist = this.history = makeHistory(this.history.maxGeneration);
      hist.done = histData.done.slice(0);
      hist.undone = histData.undone.slice(0);
    },

    markText: function(from, to, options) {
      return markText(this, clipPos(this, from), clipPos(this, to), options, "range");
    },
    setBookmark: function(pos, options) {
      var realOpts = {replacedWith: options && (options.nodeType == null ? options.widget : options),
                      insertLeft: options && options.insertLeft,
                      clearWhenEmpty: false};
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
    findMarks: function(from, to) {
      from = clipPos(this, from); to = clipPos(this, to);
      var found = [], lineNo = from.line;
      this.iter(from.line, to.line + 1, function(line) {
        var spans = line.markedSpans;
        if (spans) for (var i = 0; i < spans.length; i++) {
          var span = spans[i];
          if (!(lineNo == from.line && from.ch > span.to ||
                span.from == null && lineNo != from.line||
                lineNo == to.line && span.from > to.ch))
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
      doc.sel = {from: this.sel.from, to: this.sel.to, head: this.sel.head, anchor: this.sel.anchor,
                 shift: this.sel.shift, extend: false, goalColumn: this.sel.goalColumn};
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
      return copy;
    },
    unlinkDoc: function(other) {
      if (other instanceof CodeMirror) other = other.doc;
      if (this.linked) for (var i = 0; i < this.linked.length; ++i) {
        var link = this.linked[i];
        if (link.doc != other) continue;
        this.linked.splice(i, 1);
        other.unlinkDoc(this);
        break;
      }
      // If the histories were shared, split them again
      if (other.history == this.history) {
        var splitIds = [other.id];
        linkedDocs(other, function(doc) {splitIds.push(doc.id);}, true);
        other.history = makeHistory();
        other.history.done = copyHistoryArray(this.history.done, splitIds);
        other.history.undone = copyHistoryArray(this.history.undone, splitIds);
      }
    },
    iterLinkedDocs: function(f) {linkedDocs(this, f);},

    getMode: function() {return this.mode;},
    getEditor: function() {return this.cm;}
  });

  Doc.prototype.eachLine = Doc.prototype.iter;

  // The Doc methods that should be available on CodeMirror instances
  var dontDelegate = "iter insert remove copy getEditor".split(" ");
  for (var prop in Doc.prototype) if (Doc.prototype.hasOwnProperty(prop) && indexOf(dontDelegate, prop) < 0)
    CodeMirror.prototype[prop] = (function(method) {
      return function() {return method.apply(this.doc, arguments);};
    })(Doc.prototype[prop]);

  eventMixin(Doc);

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

  function attachDoc(cm, doc) {
    if (doc.cm) throw new Error("This document is already in use.");
    cm.doc = doc;
    doc.cm = cm;
    estimateLineHeights(cm);
    loadMode(cm);
    if (!cm.options.lineWrapping) computeMaxLength(cm);
    cm.options.mode = doc.modeOption;
    regChange(cm);
  }

  // LINE UTILITIES

  function getLine(chunk, n) {
    n -= chunk.first;
    while (!chunk.lines) {
      for (var i = 0;; ++i) {
        var child = chunk.children[i], sz = child.chunkSize();
        if (n < sz) { chunk = child; break; }
        n -= sz;
      }
    }
    return chunk.lines[n];
  }

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
  function getLines(doc, from, to) {
    var out = [];
    doc.iter(from, to, function(line) { out.push(line.text); });
    return out;
  }

  function updateLineHeight(line, height) {
    var diff = height - line.height;
    for (var n = line; n; n = n.parent) n.height += diff;
  }

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

  function lineAtHeight(chunk, h) {
    var n = chunk.first;
    outer: do {
      for (var i = 0, e = chunk.children.length; i < e; ++i) {
        var child = chunk.children[i], ch = child.height;
        if (h < ch) { chunk = child; continue outer; }
        h -= ch;
        n += child.chunkSize();
      }
      return n;
    } while (!chunk.lines);
    for (var i = 0, e = chunk.lines.length; i < e; ++i) {
      var line = chunk.lines[i], lh = line.height;
      if (h < lh) break;
      h -= lh;
    }
    return n + i;
  }

  function heightAtLine(cm, lineObj) {
    lineObj = visualLine(cm.doc, lineObj);

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

  function getOrder(line) {
    var order = line.order;
    if (order == null) order = line.order = bidiOrdering(line.text);
    return order;
  }

  // HISTORY

  function makeHistory(startGen) {
    return {
      // Arrays of history events. Doing something adds an event to
      // done and clears undo. Undoing moves events from done to
      // undone, redoing moves them in the other direction.
      done: [], undone: [], undoDepth: Infinity,
      // Used to track when changes can be merged into a single undo
      // event
      lastTime: 0, lastOp: null, lastOrigin: null,
      // Used by the isClean() method
      generation: startGen || 1, maxGeneration: startGen || 1
    };
  }

  function attachLocalSpans(doc, change, from, to) {
    var existing = change["spans_" + doc.id], n = 0;
    doc.iter(Math.max(doc.first, from), Math.min(doc.first + doc.size, to), function(line) {
      if (line.markedSpans)
        (existing || (existing = change["spans_" + doc.id] = {}))[n] = line.markedSpans;
      ++n;
    });
  }

  function historyChangeFromChange(doc, change) {
    var from = { line: change.from.line, ch: change.from.ch };
    var histChange = {from: from, to: changeEnd(change), text: getBetween(doc, change.from, change.to)};
    attachLocalSpans(doc, histChange, change.from.line, change.to.line + 1);
    linkedDocs(doc, function(doc) {attachLocalSpans(doc, histChange, change.from.line, change.to.line + 1);}, true);
    return histChange;
  }

  function addToHistory(doc, change, selAfter, opId) {
    var hist = doc.history;
    hist.undone.length = 0;
    var time = +new Date, cur = lst(hist.done);

    if (cur &&
        (hist.lastOp == opId ||
         hist.lastOrigin == change.origin && change.origin &&
         ((change.origin.charAt(0) == "+" && doc.cm && hist.lastTime > time - doc.cm.options.historyEventDelay) ||
          change.origin.charAt(0) == "*"))) {
      // Merge this change into the last event
      var last = lst(cur.changes);
      if (posEq(change.from, change.to) && posEq(change.from, last.to)) {
        // Optimized case for simple insertion -- don't want to add
        // new changesets for every character typed
        last.to = changeEnd(change);
      } else {
        // Add new sub-event
        cur.changes.push(historyChangeFromChange(doc, change));
      }
      cur.anchorAfter = selAfter.anchor; cur.headAfter = selAfter.head;
    } else {
      // Can not be merged, start a new event.
      cur = {changes: [historyChangeFromChange(doc, change)],
             generation: hist.generation,
             anchorBefore: doc.sel.anchor, headBefore: doc.sel.head,
             anchorAfter: selAfter.anchor, headAfter: selAfter.head};
      hist.done.push(cur);
      while (hist.done.length > hist.undoDepth)
        hist.done.shift();
    }
    hist.generation = ++hist.maxGeneration;
    hist.lastTime = time;
    hist.lastOp = opId;
    hist.lastOrigin = change.origin;

    if (!last) signal(doc, "historyAdded");
  }

  function removeClearedSpans(spans) {
    if (!spans) return null;
    for (var i = 0, out; i < spans.length; ++i) {
      if (spans[i].marker.explicitlyCleared) { if (!out) out = spans.slice(0, i); }
      else if (out) out.push(spans[i]);
    }
    return !out ? spans : out.length ? out : null;
  }

  function getOldSpans(doc, change) {
    var found = change["spans_" + doc.id];
    if (!found) return null;
    for (var i = 0, nw = []; i < change.text.length; ++i)
      nw.push(removeClearedSpans(found[i]));
    return nw;
  }

  // Used both to provide a JSON-safe object in .getHistory, and, when
  // detaching a document, to split the history in two
  function copyHistoryArray(events, newGroup) {
    for (var i = 0, copy = []; i < events.length; ++i) {
      var event = events[i], changes = event.changes, newChanges = [];
      copy.push({changes: newChanges, anchorBefore: event.anchorBefore, headBefore: event.headBefore,
                 anchorAfter: event.anchorAfter, headAfter: event.headAfter});
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

  function rebaseHistSel(pos, from, to, diff) {
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
      for (var j = 0; j < sub.changes.length; ++j) {
        var cur = sub.changes[j];
        if (!sub.copied) { cur.from = copyPos(cur.from); cur.to = copyPos(cur.to); }
        if (to < cur.from.line) {
          cur.from.line += diff;
          cur.to.line += diff;
        } else if (from <= cur.to.line) {
          ok = false;
          break;
        }
      }
      if (!sub.copied) {
        sub.anchorBefore = copyPos(sub.anchorBefore); sub.headBefore = copyPos(sub.headBefore);
        sub.anchorAfter = copyPos(sub.anchorAfter); sub.readAfter = copyPos(sub.headAfter);
        sub.copied = true;
      }
      if (!ok) {
        array.splice(0, i + 1);
        i = 0;
      } else {
        rebaseHistSel(sub.anchorBefore); rebaseHistSel(sub.headBefore);
        rebaseHistSel(sub.anchorAfter); rebaseHistSel(sub.headAfter);
      }
    }
  }

  function rebaseHist(hist, change) {
    var from = change.from.line, to = change.to.line, diff = change.text.length - (to - from) - 1;
    rebaseHistArray(hist.done, from, to, diff);
    rebaseHistArray(hist.undone, from, to, diff);
  }

  // EVENT OPERATORS

  function stopMethod() {e_stop(this);}
  // Ensure an event has a stop method.
  function addStop(event) {
    if (!event.stop) event.stop = stopMethod;
    return event;
  }

  function e_preventDefault(e) {
    if (e.preventDefault) e.preventDefault();
    else e.returnValue = false;
  }
  function e_stopPropagation(e) {
    if (e.stopPropagation) e.stopPropagation();
    else e.cancelBubble = true;
  }
  function e_defaultPrevented(e) {
    return e.defaultPrevented != null ? e.defaultPrevented : e.returnValue == false;
  }
  function e_stop(e) {e_preventDefault(e); e_stopPropagation(e);}
  CodeMirror.e_stop = e_stop;
  CodeMirror.e_preventDefault = e_preventDefault;
  CodeMirror.e_stopPropagation = e_stopPropagation;

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

  function on(emitter, type, f) {
    if (emitter.addEventListener)
      emitter.addEventListener(type, f, false);
    else if (emitter.attachEvent)
      emitter.attachEvent("on" + type, f);
    else {
      var map = emitter._handlers || (emitter._handlers = {});
      var arr = map[type] || (map[type] = []);
      arr.push(f);
    }
  }

  function off(emitter, type, f) {
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
  }

  function signal(emitter, type /*, values...*/) {
    var arr = emitter._handlers && emitter._handlers[type];
    if (!arr) return;
    var args = Array.prototype.slice.call(arguments, 2);
    for (var i = 0; i < arr.length; ++i) arr[i].apply(null, args);
  }

  var delayedCallbacks, delayedCallbackDepth = 0;
  function signalLater(emitter, type /*, values...*/) {
    var arr = emitter._handlers && emitter._handlers[type];
    if (!arr) return;
    var args = Array.prototype.slice.call(arguments, 2);
    if (!delayedCallbacks) {
      ++delayedCallbackDepth;
      delayedCallbacks = [];
      setTimeout(fireDelayed, 0);
    }
    function bnd(f) {return function(){f.apply(null, args);};};
    for (var i = 0; i < arr.length; ++i)
      delayedCallbacks.push(bnd(arr[i]));
  }

  function signalDOMEvent(cm, e, override) {
    signal(cm, override || e.type, cm, e);
    return e_defaultPrevented(e) || e.codemirrorIgnore;
  }

  function fireDelayed() {
    --delayedCallbackDepth;
    var delayed = delayedCallbacks;
    delayedCallbacks = null;
    for (var i = 0; i < delayed.length; ++i) delayed[i]();
  }

  function hasHandler(emitter, type) {
    var arr = emitter._handlers && emitter._handlers[type];
    return arr && arr.length > 0;
  }

  CodeMirror.on = on; CodeMirror.off = off; CodeMirror.signal = signal;

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

  function Delayed() {this.id = null;}
  Delayed.prototype = {set: function(ms, f) {clearTimeout(this.id); this.id = setTimeout(f, ms);}};

  // Counts the column offset in a string, taking tabs into account.
  // Used mostly to find indentation.
  function countColumn(string, end, tabSize, startIndex, startValue) {
    if (end == null) {
      end = string.search(/[^\s\u00a0]/);
      if (end == -1) end = string.length;
    }
    for (var i = startIndex || 0, n = startValue || 0; i < end; ++i) {
      if (string.charAt(i) == "\t") n += tabSize - (n % tabSize);
      else ++n;
    }
    return n;
  }
  CodeMirror.countColumn = countColumn;

  var spaceStrs = [""];
  function spaceStr(n) {
    while (spaceStrs.length <= n)
      spaceStrs.push(lst(spaceStrs) + " ");
    return spaceStrs[n];
  }

  function lst(arr) { return arr[arr.length-1]; }

  function selectInput(node) {
    if (ios) { // Mobile Safari apparently has a bug where select() is broken.
      node.selectionStart = 0;
      node.selectionEnd = node.value.length;
    } else {
      // Suppress mysterious IE10 errors
      try { node.select(); }
      catch(_e) {}
    }
  }

  function indexOf(collection, elt) {
    if (collection.indexOf) return collection.indexOf(elt);
    for (var i = 0, e = collection.length; i < e; ++i)
      if (collection[i] == elt) return i;
    return -1;
  }

  function createObj(base, props) {
    function Obj() {}
    Obj.prototype = base;
    var inst = new Obj();
    if (props) copyObj(props, inst);
    return inst;
  }

  function copyObj(obj, target) {
    if (!target) target = {};
    for (var prop in obj) if (obj.hasOwnProperty(prop)) target[prop] = obj[prop];
    return target;
  }

  function emptyArray(size) {
    for (var a = [], i = 0; i < size; ++i) a.push(undefined);
    return a;
  }

  function bind(f) {
    var args = Array.prototype.slice.call(arguments, 1);
    return function(){return f.apply(null, args);};
  }

  var nonASCIISingleCaseWordChar = /[\u00df\u3040-\u309f\u30a0-\u30ff\u3400-\u4db5\u4e00-\u9fcc\uac00-\ud7af]/;
  function isWordChar(ch) {
    return /\w/.test(ch) || ch > "\x80" &&
      (ch.toUpperCase() != ch.toLowerCase() || nonASCIISingleCaseWordChar.test(ch));
  }

  function isEmpty(obj) {
    for (var n in obj) if (obj.hasOwnProperty(n) && obj[n]) return false;
    return true;
  }

  var extendingChars = /[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u0610-\u061a\u064b-\u065e\u0670\u06d6-\u06dc\u06de-\u06e4\u06e7\u06e8\u06ea-\u06ed\u0711\u0730-\u074a\u07a6-\u07b0\u07eb-\u07f3\u0816-\u0819\u081b-\u0823\u0825-\u0827\u0829-\u082d\u0900-\u0902\u093c\u0941-\u0948\u094d\u0951-\u0955\u0962\u0963\u0981\u09bc\u09be\u09c1-\u09c4\u09cd\u09d7\u09e2\u09e3\u0a01\u0a02\u0a3c\u0a41\u0a42\u0a47\u0a48\u0a4b-\u0a4d\u0a51\u0a70\u0a71\u0a75\u0a81\u0a82\u0abc\u0ac1-\u0ac5\u0ac7\u0ac8\u0acd\u0ae2\u0ae3\u0b01\u0b3c\u0b3e\u0b3f\u0b41-\u0b44\u0b4d\u0b56\u0b57\u0b62\u0b63\u0b82\u0bbe\u0bc0\u0bcd\u0bd7\u0c3e-\u0c40\u0c46-\u0c48\u0c4a-\u0c4d\u0c55\u0c56\u0c62\u0c63\u0cbc\u0cbf\u0cc2\u0cc6\u0ccc\u0ccd\u0cd5\u0cd6\u0ce2\u0ce3\u0d3e\u0d41-\u0d44\u0d4d\u0d57\u0d62\u0d63\u0dca\u0dcf\u0dd2-\u0dd4\u0dd6\u0ddf\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\u0eb1\u0eb4-\u0eb9\u0ebb\u0ebc\u0ec8-\u0ecd\u0f18\u0f19\u0f35\u0f37\u0f39\u0f71-\u0f7e\u0f80-\u0f84\u0f86\u0f87\u0f90-\u0f97\u0f99-\u0fbc\u0fc6\u102d-\u1030\u1032-\u1037\u1039\u103a\u103d\u103e\u1058\u1059\u105e-\u1060\u1071-\u1074\u1082\u1085\u1086\u108d\u109d\u135f\u1712-\u1714\u1732-\u1734\u1752\u1753\u1772\u1773\u17b7-\u17bd\u17c6\u17c9-\u17d3\u17dd\u180b-\u180d\u18a9\u1920-\u1922\u1927\u1928\u1932\u1939-\u193b\u1a17\u1a18\u1a56\u1a58-\u1a5e\u1a60\u1a62\u1a65-\u1a6c\u1a73-\u1a7c\u1a7f\u1b00-\u1b03\u1b34\u1b36-\u1b3a\u1b3c\u1b42\u1b6b-\u1b73\u1b80\u1b81\u1ba2-\u1ba5\u1ba8\u1ba9\u1c2c-\u1c33\u1c36\u1c37\u1cd0-\u1cd2\u1cd4-\u1ce0\u1ce2-\u1ce8\u1ced\u1dc0-\u1de6\u1dfd-\u1dff\u200c\u200d\u20d0-\u20f0\u2cef-\u2cf1\u2de0-\u2dff\u302a-\u302f\u3099\u309a\ua66f-\ua672\ua67c\ua67d\ua6f0\ua6f1\ua802\ua806\ua80b\ua825\ua826\ua8c4\ua8e0-\ua8f1\ua926-\ua92d\ua947-\ua951\ua980-\ua982\ua9b3\ua9b6-\ua9b9\ua9bc\uaa29-\uaa2e\uaa31\uaa32\uaa35\uaa36\uaa43\uaa4c\uaab0\uaab2-\uaab4\uaab7\uaab8\uaabe\uaabf\uaac1\uabe5\uabe8\uabed\udc00-\udfff\ufb1e\ufe00-\ufe0f\ufe20-\ufe26\uff9e\uff9f]/;
  function isExtendingChar(ch) { return ch.charCodeAt(0) >= 768 && extendingChars.test(ch); }

  // DOM UTILITIES

  function elt(tag, content, className, style) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (style) e.style.cssText = style;
    if (typeof content == "string") setTextContent(e, content);
    else if (content) for (var i = 0; i < content.length; ++i) e.appendChild(content[i]);
    return e;
  }

  function removeChildren(e) {
    for (var count = e.childNodes.length; count > 0; --count)
      e.removeChild(e.firstChild);
    return e;
  }

  function removeChildrenAndAdd(parent, e) {
    return removeChildren(parent).appendChild(e);
  }

  function setTextContent(e, str) {
    if (ie_lt9) {
      e.innerHTML = "";
      e.appendChild(document.createTextNode(str));
    } else e.textContent = str;
  }

  function getRect(node) {
    return node.getBoundingClientRect();
  }
  CodeMirror.replaceGetRect = function(f) { getRect = f; };

  // FEATURE DETECTION

  // Detect drag-and-drop
  var dragAndDrop = function() {
    // There is *some* kind of drag-and-drop support in IE6-8, but I
    // couldn't get it to work yet.
    if (ie_lt9) return false;
    var div = elt('div');
    return "draggable" in div || "dragDrop" in div;
  }();

  // For a reason I have yet to figure out, some browsers disallow
  // word wrapping between certain characters *only* if a new inline
  // element is started between them. This makes it hard to reliably
  // measure the position of things, since that requires inserting an
  // extra span. This terribly fragile set of tests matches the
  // character combinations that suffer from this phenomenon on the
  // various browsers.
  function spanAffectsWrapping() { return false; }
  if (gecko) // Only for "$'"
    spanAffectsWrapping = function(str, i) {
      return str.charCodeAt(i - 1) == 36 && str.charCodeAt(i) == 39;
    };
  else if (safari && !/Version\/([6-9]|\d\d)\b/.test(navigator.userAgent))
    spanAffectsWrapping = function(str, i) {
      return /\-[^ \-?]|\?[^ !\'\"\),.\-\/:;\?\]\}]/.test(str.slice(i - 1, i + 1));
    };
  else if (webkit && /Chrome\/(?:29|[3-9]\d|\d\d\d)\./.test(navigator.userAgent))
    spanAffectsWrapping = function(str, i) {
      var code = str.charCodeAt(i - 1);
      return code >= 8208 && code <= 8212;
    };
  else if (webkit)
    spanAffectsWrapping = function(str, i) {
      if (i > 1 && str.charCodeAt(i - 1) == 45) {
        if (/\w/.test(str.charAt(i - 2)) && /[^\-?\.]/.test(str.charAt(i))) return true;
        if (i > 2 && /[\d\.,]/.test(str.charAt(i - 2)) && /[\d\.,]/.test(str.charAt(i))) return false;
      }
      return /[~!#%&*)=+}\]\\|\"\.>,:;][({[<]|-[^\-?\.\u2010-\u201f\u2026]|\?[\w~`@#$%\^&*(_=+{[|><]|\u2026[\w~`@#$%\^&*(_=+{[><]/.test(str.slice(i - 1, i + 1));
    };

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
        zwspSupported = test.offsetWidth <= 1 && test.offsetHeight > 2 && !ie_lt8;
    }
    if (zwspSupported) return elt("span", "\u200b");
    else return elt("span", "\u00a0", null, "display: inline-block; width: 1px; margin-right: -1px");
  }

  // See if "".split is the broken IE version, if so, provide an
  // alternative way to split lines.
  var splitLines = "\n\nb".split(/\n/).length != 3 ? function(string) {
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
  CodeMirror.splitLines = splitLines;

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
    return typeof e.oncopy == 'function';
  })();

  // KEY NAMING

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
    var visual = visualLine(cm.doc, line);
    if (visual != line) lineN = lineNo(visual);
    var order = getOrder(visual);
    var ch = !order ? 0 : order[0].level % 2 ? lineRight(visual) : lineLeft(visual);
    return Pos(lineN, ch);
  }
  function lineEnd(cm, lineN) {
    var merged, line;
    while (merged = collapsedSpanAtEnd(line = getLine(cm.doc, lineN)))
      lineN = merged.find().to.line;
    var order = getOrder(line);
    var ch = !order ? line.text.length : order[0].level % 2 ? lineLeft(line) : lineRight(line);
    return Pos(lineN, ch);
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

  // This is somewhat involved. It is needed in order to move
  // 'visually' through bi-directional text -- i.e., pressing left
  // should make the cursor go left, even when in RTL text. The
  // tricky part is the 'jumps', where RTL and LTR text touch each
  // other. This often requires the cursor offset to move more than
  // one unit, in order to visually move one unit.
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
    var lowTypes = "bbbbbbbbbtstwsbbbbbbbbbbbbbbssstwNN%%%NNNNNN,N,N1111111111NNNNNNNLLLLLLLLLLLLLLLLLLLLLLLLLLNNNNNNLLLLLLLLLLLLLLLLLLLLLLLLLLNNNNbbbbbbsbbbbbbbbbbbbbbbbbbbbbbbbbb,N%%%%NNNNLNNNNN%%11NLNNN1LNNNNNLLLLLLLLLLLLLLLLLLLLLLLNLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLNLLLLLLLL";
    // Character types for codepoints 0x600 to 0x6ff
    var arabicTypes = "rrrrrrrrrrrr,rNNmmmmmmrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrmmmmmmmmmmmmmmrrrrrrrnnnnnnnnnn%nnrrrmrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrmmmmmmmmmmmmmmmmmmmNmmmmrrrrrrrrrrrrrrrrrr";
    function charType(code) {
      if (code <= 0xff) return lowTypes.charAt(code);
      else if (0x590 <= code && code <= 0x5f4) return "R";
      else if (0x600 <= code && code <= 0x6ff) return arabicTypes.charAt(code - 0x600);
      else if (0x700 <= code && code <= 0x8ac) return "r";
      else return "L";
    }

    var bidiRE = /[\u0590-\u05f4\u0600-\u06ff\u0700-\u08ac]/;
    var isNeutral = /[stwN]/, isStrong = /[LRr]/, countsAsLeft = /[Lb1n]/, countsAsNum = /[1n]/;
    // Browsers seem to always treat the boundaries of block elements as being L.
    var outerType = "L";

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
          order.push({from: start, to: i, level: 0});
        } else {
          var pos = i, at = order.length;
          for (++i; i < len && types[i] != "L"; ++i) {}
          for (var j = pos; j < i;) {
            if (countsAsNum.test(types[j])) {
              if (pos < j) order.splice(at, 0, {from: pos, to: j, level: 1});
              var nstart = j;
              for (++j; j < i && countsAsNum.test(types[j]); ++j) {}
              order.splice(at, 0, {from: nstart, to: j, level: 2});
              pos = j;
            } else ++j;
          }
          if (pos < i) order.splice(at, 0, {from: pos, to: i, level: 1});
        }
      }
      if (order[0].level == 1 && (m = str.match(/^\s+/))) {
        order[0].from = m[0].length;
        order.unshift({from: 0, to: m[0].length, level: 0});
      }
      if (lst(order).level == 1 && (m = str.match(/\s+$/))) {
        lst(order).to -= m[0].length;
        order.push({from: len - m[0].length, to: len, level: 0});
      }
      if (order[0].level != lst(order).level)
        order.push({from: len, to: len, level: order[0].level});

      return order;
    };
  })();

  // THE END

  CodeMirror.version = "3.22.0";

  return CodeMirror;
})();

},{}],2:[function(require,module,exports){
var CodeMirror = require('code-mirror');

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


},{"code-mirror":1}],3:[function(require,module,exports){
var element = require('./element.js');
element('x-editor');

},{"./element.js":2}]},{},[3])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9Vc2Vycy9zb2xlL2RhdGEveC1lZGl0b3Ivbm9kZV9tb2R1bGVzL2d1bHAtYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvYnJvd3Nlci1wYWNrL19wcmVsdWRlLmpzIiwiL1VzZXJzL3NvbGUvZGF0YS94LWVkaXRvci9ub2RlX21vZHVsZXMvY29kZS1taXJyb3IvY29kZW1pcnJvci5qcyIsIi9Vc2Vycy9zb2xlL2RhdGEveC1lZGl0b3Ivc3JjL2pzL2VsZW1lbnQuanMiLCIvVXNlcnMvc29sZS9kYXRhL3gtZWRpdG9yL3NyYy9qcy9mYWtlXzg5ZDFkOTI2LmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMzOExBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BJQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dGhyb3cgbmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKX12YXIgZj1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwoZi5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxmLGYuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pIiwiLy8gQ29kZU1pcnJvciBpcyB0aGUgb25seSBnbG9iYWwgdmFyIHdlIGNsYWltXG5tb2R1bGUuZXhwb3J0cyA9IChmdW5jdGlvbigpIHtcbiAgXCJ1c2Ugc3RyaWN0XCI7XG5cbiAgLy8gQlJPV1NFUiBTTklGRklOR1xuXG4gIC8vIENydWRlLCBidXQgbmVjZXNzYXJ5IHRvIGhhbmRsZSBhIG51bWJlciBvZiBoYXJkLXRvLWZlYXR1cmUtZGV0ZWN0XG4gIC8vIGJ1Z3MgYW5kIGJlaGF2aW9yIGRpZmZlcmVuY2VzLlxuICB2YXIgZ2Vja28gPSAvZ2Vja29cXC9cXGQvaS50ZXN0KG5hdmlnYXRvci51c2VyQWdlbnQpO1xuICAvLyBJRTExIGN1cnJlbnRseSBkb2Vzbid0IGNvdW50IGFzICdpZScsIHNpbmNlIGl0IGhhcyBhbG1vc3Qgbm9uZSBvZlxuICAvLyB0aGUgc2FtZSBidWdzIGFzIGVhcmxpZXIgdmVyc2lvbnMuIFVzZSBpZV9ndDEwIHRvIGhhbmRsZVxuICAvLyBpbmNvbXBhdGliaWxpdGllcyBpbiB0aGF0IHZlcnNpb24uXG4gIHZhciBvbGRfaWUgPSAvTVNJRSBcXGQvLnRlc3QobmF2aWdhdG9yLnVzZXJBZ2VudCk7XG4gIHZhciBpZV9sdDggPSBvbGRfaWUgJiYgKGRvY3VtZW50LmRvY3VtZW50TW9kZSA9PSBudWxsIHx8IGRvY3VtZW50LmRvY3VtZW50TW9kZSA8IDgpO1xuICB2YXIgaWVfbHQ5ID0gb2xkX2llICYmIChkb2N1bWVudC5kb2N1bWVudE1vZGUgPT0gbnVsbCB8fCBkb2N1bWVudC5kb2N1bWVudE1vZGUgPCA5KTtcbiAgdmFyIGllX2x0MTAgPSBvbGRfaWUgJiYgKGRvY3VtZW50LmRvY3VtZW50TW9kZSA9PSBudWxsIHx8IGRvY3VtZW50LmRvY3VtZW50TW9kZSA8IDEwKTtcbiAgdmFyIGllX2d0MTAgPSAvVHJpZGVudFxcLyhbNy05XXxcXGR7Mix9KVxcLi8udGVzdChuYXZpZ2F0b3IudXNlckFnZW50KTtcbiAgdmFyIGllID0gb2xkX2llIHx8IGllX2d0MTA7XG4gIHZhciB3ZWJraXQgPSAvV2ViS2l0XFwvLy50ZXN0KG5hdmlnYXRvci51c2VyQWdlbnQpO1xuICB2YXIgcXR3ZWJraXQgPSB3ZWJraXQgJiYgL1F0XFwvXFxkK1xcLlxcZCsvLnRlc3QobmF2aWdhdG9yLnVzZXJBZ2VudCk7XG4gIHZhciBjaHJvbWUgPSAvQ2hyb21lXFwvLy50ZXN0KG5hdmlnYXRvci51c2VyQWdlbnQpO1xuICB2YXIgb3BlcmEgPSAvT3BlcmFcXC8vLnRlc3QobmF2aWdhdG9yLnVzZXJBZ2VudCk7XG4gIHZhciBzYWZhcmkgPSAvQXBwbGUgQ29tcHV0ZXIvLnRlc3QobmF2aWdhdG9yLnZlbmRvcik7XG4gIHZhciBraHRtbCA9IC9LSFRNTFxcLy8udGVzdChuYXZpZ2F0b3IudXNlckFnZW50KTtcbiAgdmFyIG1hY19nZUxpb24gPSAvTWFjIE9TIFggMVxcZFxcRChbNy05XXxcXGRcXGQpXFxELy50ZXN0KG5hdmlnYXRvci51c2VyQWdlbnQpO1xuICB2YXIgbWFjX2dlTW91bnRhaW5MaW9uID0gL01hYyBPUyBYIDFcXGRcXEQoWzgtOV18XFxkXFxkKVxcRC8udGVzdChuYXZpZ2F0b3IudXNlckFnZW50KTtcbiAgdmFyIHBoYW50b20gPSAvUGhhbnRvbUpTLy50ZXN0KG5hdmlnYXRvci51c2VyQWdlbnQpO1xuXG4gIHZhciBpb3MgPSAvQXBwbGVXZWJLaXQvLnRlc3QobmF2aWdhdG9yLnVzZXJBZ2VudCkgJiYgL01vYmlsZVxcL1xcdysvLnRlc3QobmF2aWdhdG9yLnVzZXJBZ2VudCk7XG4gIC8vIFRoaXMgaXMgd29lZnVsbHkgaW5jb21wbGV0ZS4gU3VnZ2VzdGlvbnMgZm9yIGFsdGVybmF0aXZlIG1ldGhvZHMgd2VsY29tZS5cbiAgdmFyIG1vYmlsZSA9IGlvcyB8fCAvQW5kcm9pZHx3ZWJPU3xCbGFja0JlcnJ5fE9wZXJhIE1pbml8T3BlcmEgTW9iaXxJRU1vYmlsZS9pLnRlc3QobmF2aWdhdG9yLnVzZXJBZ2VudCk7XG4gIHZhciBtYWMgPSBpb3MgfHwgL01hYy8udGVzdChuYXZpZ2F0b3IucGxhdGZvcm0pO1xuICB2YXIgd2luZG93cyA9IC93aW4vaS50ZXN0KG5hdmlnYXRvci5wbGF0Zm9ybSk7XG5cbiAgdmFyIG9wZXJhX3ZlcnNpb24gPSBvcGVyYSAmJiBuYXZpZ2F0b3IudXNlckFnZW50Lm1hdGNoKC9WZXJzaW9uXFwvKFxcZCpcXC5cXGQqKS8pO1xuICBpZiAob3BlcmFfdmVyc2lvbikgb3BlcmFfdmVyc2lvbiA9IE51bWJlcihvcGVyYV92ZXJzaW9uWzFdKTtcbiAgaWYgKG9wZXJhX3ZlcnNpb24gJiYgb3BlcmFfdmVyc2lvbiA+PSAxNSkgeyBvcGVyYSA9IGZhbHNlOyB3ZWJraXQgPSB0cnVlOyB9XG4gIC8vIFNvbWUgYnJvd3NlcnMgdXNlIHRoZSB3cm9uZyBldmVudCBwcm9wZXJ0aWVzIHRvIHNpZ25hbCBjbWQvY3RybCBvbiBPUyBYXG4gIHZhciBmbGlwQ3RybENtZCA9IG1hYyAmJiAocXR3ZWJraXQgfHwgb3BlcmEgJiYgKG9wZXJhX3ZlcnNpb24gPT0gbnVsbCB8fCBvcGVyYV92ZXJzaW9uIDwgMTIuMTEpKTtcbiAgdmFyIGNhcHR1cmVNaWRkbGVDbGljayA9IGdlY2tvIHx8IChpZSAmJiAhaWVfbHQ5KTtcblxuICAvLyBPcHRpbWl6ZSBzb21lIGNvZGUgd2hlbiB0aGVzZSBmZWF0dXJlcyBhcmUgbm90IHVzZWRcbiAgdmFyIHNhd1JlYWRPbmx5U3BhbnMgPSBmYWxzZSwgc2F3Q29sbGFwc2VkU3BhbnMgPSBmYWxzZTtcblxuICAvLyBDT05TVFJVQ1RPUlxuXG4gIGZ1bmN0aW9uIENvZGVNaXJyb3IocGxhY2UsIG9wdGlvbnMpIHtcbiAgICBpZiAoISh0aGlzIGluc3RhbmNlb2YgQ29kZU1pcnJvcikpIHJldHVybiBuZXcgQ29kZU1pcnJvcihwbGFjZSwgb3B0aW9ucyk7XG5cbiAgICB0aGlzLm9wdGlvbnMgPSBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcbiAgICAvLyBEZXRlcm1pbmUgZWZmZWN0aXZlIG9wdGlvbnMgYmFzZWQgb24gZ2l2ZW4gdmFsdWVzIGFuZCBkZWZhdWx0cy5cbiAgICBmb3IgKHZhciBvcHQgaW4gZGVmYXVsdHMpIGlmICghb3B0aW9ucy5oYXNPd25Qcm9wZXJ0eShvcHQpICYmIGRlZmF1bHRzLmhhc093blByb3BlcnR5KG9wdCkpXG4gICAgICBvcHRpb25zW29wdF0gPSBkZWZhdWx0c1tvcHRdO1xuICAgIHNldEd1dHRlcnNGb3JMaW5lTnVtYmVycyhvcHRpb25zKTtcblxuICAgIHZhciBkb2NTdGFydCA9IHR5cGVvZiBvcHRpb25zLnZhbHVlID09IFwic3RyaW5nXCIgPyAwIDogb3B0aW9ucy52YWx1ZS5maXJzdDtcbiAgICB2YXIgZGlzcGxheSA9IHRoaXMuZGlzcGxheSA9IG1ha2VEaXNwbGF5KHBsYWNlLCBkb2NTdGFydCk7XG4gICAgZGlzcGxheS53cmFwcGVyLkNvZGVNaXJyb3IgPSB0aGlzO1xuICAgIHVwZGF0ZUd1dHRlcnModGhpcyk7XG4gICAgaWYgKG9wdGlvbnMuYXV0b2ZvY3VzICYmICFtb2JpbGUpIGZvY3VzSW5wdXQodGhpcyk7XG5cbiAgICB0aGlzLnN0YXRlID0ge2tleU1hcHM6IFtdLFxuICAgICAgICAgICAgICAgICAgb3ZlcmxheXM6IFtdLFxuICAgICAgICAgICAgICAgICAgbW9kZUdlbjogMCxcbiAgICAgICAgICAgICAgICAgIG92ZXJ3cml0ZTogZmFsc2UsIGZvY3VzZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgc3VwcHJlc3NFZGl0czogZmFsc2UsXG4gICAgICAgICAgICAgICAgICBwYXN0ZUluY29taW5nOiBmYWxzZSwgY3V0SW5jb21pbmc6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgZHJhZ2dpbmdUZXh0OiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgIGhpZ2hsaWdodDogbmV3IERlbGF5ZWQoKX07XG5cbiAgICB0aGVtZUNoYW5nZWQodGhpcyk7XG4gICAgaWYgKG9wdGlvbnMubGluZVdyYXBwaW5nKVxuICAgICAgdGhpcy5kaXNwbGF5LndyYXBwZXIuY2xhc3NOYW1lICs9IFwiIENvZGVNaXJyb3Itd3JhcFwiO1xuXG4gICAgdmFyIGRvYyA9IG9wdGlvbnMudmFsdWU7XG4gICAgaWYgKHR5cGVvZiBkb2MgPT0gXCJzdHJpbmdcIikgZG9jID0gbmV3IERvYyhvcHRpb25zLnZhbHVlLCBvcHRpb25zLm1vZGUpO1xuICAgIG9wZXJhdGlvbih0aGlzLCBhdHRhY2hEb2MpKHRoaXMsIGRvYyk7XG5cbiAgICAvLyBPdmVycmlkZSBtYWdpYyB0ZXh0YXJlYSBjb250ZW50IHJlc3RvcmUgdGhhdCBJRSBzb21ldGltZXMgZG9lc1xuICAgIC8vIG9uIG91ciBoaWRkZW4gdGV4dGFyZWEgb24gcmVsb2FkXG4gICAgaWYgKG9sZF9pZSkgc2V0VGltZW91dChiaW5kKHJlc2V0SW5wdXQsIHRoaXMsIHRydWUpLCAyMCk7XG5cbiAgICByZWdpc3RlckV2ZW50SGFuZGxlcnModGhpcyk7XG4gICAgLy8gSUUgdGhyb3dzIHVuc3BlY2lmaWVkIGVycm9yIGluIGNlcnRhaW4gY2FzZXMsIHdoZW5cbiAgICAvLyB0cnlpbmcgdG8gYWNjZXNzIGFjdGl2ZUVsZW1lbnQgYmVmb3JlIG9ubG9hZFxuICAgIHZhciBoYXNGb2N1czsgdHJ5IHsgaGFzRm9jdXMgPSAoZG9jdW1lbnQuYWN0aXZlRWxlbWVudCA9PSBkaXNwbGF5LmlucHV0KTsgfSBjYXRjaChlKSB7IH1cbiAgICBpZiAoaGFzRm9jdXMgfHwgKG9wdGlvbnMuYXV0b2ZvY3VzICYmICFtb2JpbGUpKSBzZXRUaW1lb3V0KGJpbmQob25Gb2N1cywgdGhpcyksIDIwKTtcbiAgICBlbHNlIG9uQmx1cih0aGlzKTtcblxuICAgIG9wZXJhdGlvbih0aGlzLCBmdW5jdGlvbigpIHtcbiAgICAgIGZvciAodmFyIG9wdCBpbiBvcHRpb25IYW5kbGVycylcbiAgICAgICAgaWYgKG9wdGlvbkhhbmRsZXJzLnByb3BlcnR5SXNFbnVtZXJhYmxlKG9wdCkpXG4gICAgICAgICAgb3B0aW9uSGFuZGxlcnNbb3B0XSh0aGlzLCBvcHRpb25zW29wdF0sIEluaXQpO1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBpbml0SG9va3MubGVuZ3RoOyArK2kpIGluaXRIb29rc1tpXSh0aGlzKTtcbiAgICB9KSgpO1xuICB9XG5cbiAgLy8gRElTUExBWSBDT05TVFJVQ1RPUlxuXG4gIGZ1bmN0aW9uIG1ha2VEaXNwbGF5KHBsYWNlLCBkb2NTdGFydCkge1xuICAgIHZhciBkID0ge307XG5cbiAgICB2YXIgaW5wdXQgPSBkLmlucHV0ID0gZWx0KFwidGV4dGFyZWFcIiwgbnVsbCwgbnVsbCwgXCJwb3NpdGlvbjogYWJzb2x1dGU7IHBhZGRpbmc6IDA7IHdpZHRoOiAxcHg7IGhlaWdodDogMWVtOyBvdXRsaW5lOiBub25lXCIpO1xuICAgIGlmICh3ZWJraXQpIGlucHV0LnN0eWxlLndpZHRoID0gXCIxMDAwcHhcIjtcbiAgICBlbHNlIGlucHV0LnNldEF0dHJpYnV0ZShcIndyYXBcIiwgXCJvZmZcIik7XG4gICAgLy8gaWYgYm9yZGVyOiAwOyAtLSBpT1MgZmFpbHMgdG8gb3BlbiBrZXlib2FyZCAoaXNzdWUgIzEyODcpXG4gICAgaWYgKGlvcykgaW5wdXQuc3R5bGUuYm9yZGVyID0gXCIxcHggc29saWQgYmxhY2tcIjtcbiAgICBpbnB1dC5zZXRBdHRyaWJ1dGUoXCJhdXRvY29ycmVjdFwiLCBcIm9mZlwiKTsgaW5wdXQuc2V0QXR0cmlidXRlKFwiYXV0b2NhcGl0YWxpemVcIiwgXCJvZmZcIik7IGlucHV0LnNldEF0dHJpYnV0ZShcInNwZWxsY2hlY2tcIiwgXCJmYWxzZVwiKTtcblxuICAgIC8vIFdyYXBzIGFuZCBoaWRlcyBpbnB1dCB0ZXh0YXJlYVxuICAgIGQuaW5wdXREaXYgPSBlbHQoXCJkaXZcIiwgW2lucHV0XSwgbnVsbCwgXCJvdmVyZmxvdzogaGlkZGVuOyBwb3NpdGlvbjogcmVsYXRpdmU7IHdpZHRoOiAzcHg7IGhlaWdodDogMHB4O1wiKTtcbiAgICAvLyBUaGUgYWN0dWFsIGZha2Ugc2Nyb2xsYmFycy5cbiAgICBkLnNjcm9sbGJhckggPSBlbHQoXCJkaXZcIiwgW2VsdChcImRpdlwiLCBudWxsLCBudWxsLCBcImhlaWdodDogMXB4XCIpXSwgXCJDb2RlTWlycm9yLWhzY3JvbGxiYXJcIik7XG4gICAgZC5zY3JvbGxiYXJWID0gZWx0KFwiZGl2XCIsIFtlbHQoXCJkaXZcIiwgbnVsbCwgbnVsbCwgXCJ3aWR0aDogMXB4XCIpXSwgXCJDb2RlTWlycm9yLXZzY3JvbGxiYXJcIik7XG4gICAgZC5zY3JvbGxiYXJGaWxsZXIgPSBlbHQoXCJkaXZcIiwgbnVsbCwgXCJDb2RlTWlycm9yLXNjcm9sbGJhci1maWxsZXJcIik7XG4gICAgZC5ndXR0ZXJGaWxsZXIgPSBlbHQoXCJkaXZcIiwgbnVsbCwgXCJDb2RlTWlycm9yLWd1dHRlci1maWxsZXJcIik7XG4gICAgLy8gRElWcyBjb250YWluaW5nIHRoZSBzZWxlY3Rpb24gYW5kIHRoZSBhY3R1YWwgY29kZVxuICAgIGQubGluZURpdiA9IGVsdChcImRpdlwiLCBudWxsLCBcIkNvZGVNaXJyb3ItY29kZVwiKTtcbiAgICBkLnNlbGVjdGlvbkRpdiA9IGVsdChcImRpdlwiLCBudWxsLCBudWxsLCBcInBvc2l0aW9uOiByZWxhdGl2ZTsgei1pbmRleDogMVwiKTtcbiAgICAvLyBCbGlua3kgY3Vyc29yLCBhbmQgZWxlbWVudCB1c2VkIHRvIGVuc3VyZSBjdXJzb3IgZml0cyBhdCB0aGUgZW5kIG9mIGEgbGluZVxuICAgIGQuY3Vyc29yID0gZWx0KFwiZGl2XCIsIFwiXFx1MDBhMFwiLCBcIkNvZGVNaXJyb3ItY3Vyc29yXCIpO1xuICAgIC8vIFNlY29uZGFyeSBjdXJzb3IsIHNob3duIHdoZW4gb24gYSAnanVtcCcgaW4gYmktZGlyZWN0aW9uYWwgdGV4dFxuICAgIGQub3RoZXJDdXJzb3IgPSBlbHQoXCJkaXZcIiwgXCJcXHUwMGEwXCIsIFwiQ29kZU1pcnJvci1jdXJzb3IgQ29kZU1pcnJvci1zZWNvbmRhcnljdXJzb3JcIik7XG4gICAgLy8gVXNlZCB0byBtZWFzdXJlIHRleHQgc2l6ZVxuICAgIGQubWVhc3VyZSA9IGVsdChcImRpdlwiLCBudWxsLCBcIkNvZGVNaXJyb3ItbWVhc3VyZVwiKTtcbiAgICAvLyBXcmFwcyBldmVyeXRoaW5nIHRoYXQgbmVlZHMgdG8gZXhpc3QgaW5zaWRlIHRoZSB2ZXJ0aWNhbGx5LXBhZGRlZCBjb29yZGluYXRlIHN5c3RlbVxuICAgIGQubGluZVNwYWNlID0gZWx0KFwiZGl2XCIsIFtkLm1lYXN1cmUsIGQuc2VsZWN0aW9uRGl2LCBkLmxpbmVEaXYsIGQuY3Vyc29yLCBkLm90aGVyQ3Vyc29yXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICBudWxsLCBcInBvc2l0aW9uOiByZWxhdGl2ZTsgb3V0bGluZTogbm9uZVwiKTtcbiAgICAvLyBNb3ZlZCBhcm91bmQgaXRzIHBhcmVudCB0byBjb3ZlciB2aXNpYmxlIHZpZXdcbiAgICBkLm1vdmVyID0gZWx0KFwiZGl2XCIsIFtlbHQoXCJkaXZcIiwgW2QubGluZVNwYWNlXSwgXCJDb2RlTWlycm9yLWxpbmVzXCIpXSwgbnVsbCwgXCJwb3NpdGlvbjogcmVsYXRpdmVcIik7XG4gICAgLy8gU2V0IHRvIHRoZSBoZWlnaHQgb2YgdGhlIHRleHQsIGNhdXNlcyBzY3JvbGxpbmdcbiAgICBkLnNpemVyID0gZWx0KFwiZGl2XCIsIFtkLm1vdmVyXSwgXCJDb2RlTWlycm9yLXNpemVyXCIpO1xuICAgIC8vIEQgaXMgbmVlZGVkIGJlY2F1c2UgYmVoYXZpb3Igb2YgZWx0cyB3aXRoIG92ZXJmbG93OiBhdXRvIGFuZCBwYWRkaW5nIGlzIGluY29uc2lzdGVudCBhY3Jvc3MgYnJvd3NlcnNcbiAgICBkLmhlaWdodEZvcmNlciA9IGVsdChcImRpdlwiLCBudWxsLCBudWxsLCBcInBvc2l0aW9uOiBhYnNvbHV0ZTsgaGVpZ2h0OiBcIiArIHNjcm9sbGVyQ3V0T2ZmICsgXCJweDsgd2lkdGg6IDFweDtcIik7XG4gICAgLy8gV2lsbCBjb250YWluIHRoZSBndXR0ZXJzLCBpZiBhbnlcbiAgICBkLmd1dHRlcnMgPSBlbHQoXCJkaXZcIiwgbnVsbCwgXCJDb2RlTWlycm9yLWd1dHRlcnNcIik7XG4gICAgZC5saW5lR3V0dGVyID0gbnVsbDtcbiAgICAvLyBQcm92aWRlcyBzY3JvbGxpbmdcbiAgICBkLnNjcm9sbGVyID0gZWx0KFwiZGl2XCIsIFtkLnNpemVyLCBkLmhlaWdodEZvcmNlciwgZC5ndXR0ZXJzXSwgXCJDb2RlTWlycm9yLXNjcm9sbFwiKTtcbiAgICBkLnNjcm9sbGVyLnNldEF0dHJpYnV0ZShcInRhYkluZGV4XCIsIFwiLTFcIik7XG4gICAgLy8gVGhlIGVsZW1lbnQgaW4gd2hpY2ggdGhlIGVkaXRvciBsaXZlcy5cbiAgICBkLndyYXBwZXIgPSBlbHQoXCJkaXZcIiwgW2QuaW5wdXREaXYsIGQuc2Nyb2xsYmFySCwgZC5zY3JvbGxiYXJWLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGQuc2Nyb2xsYmFyRmlsbGVyLCBkLmd1dHRlckZpbGxlciwgZC5zY3JvbGxlcl0sIFwiQ29kZU1pcnJvclwiKTtcbiAgICAvLyBXb3JrIGFyb3VuZCBJRTcgei1pbmRleCBidWdcbiAgICBpZiAoaWVfbHQ4KSB7IGQuZ3V0dGVycy5zdHlsZS56SW5kZXggPSAtMTsgZC5zY3JvbGxlci5zdHlsZS5wYWRkaW5nUmlnaHQgPSAwOyB9XG4gICAgaWYgKHBsYWNlLmFwcGVuZENoaWxkKSBwbGFjZS5hcHBlbmRDaGlsZChkLndyYXBwZXIpOyBlbHNlIHBsYWNlKGQud3JhcHBlcik7XG5cbiAgICAvLyBOZWVkZWQgdG8gaGlkZSBiaWcgYmx1ZSBibGlua2luZyBjdXJzb3Igb24gTW9iaWxlIFNhZmFyaVxuICAgIGlmIChpb3MpIGlucHV0LnN0eWxlLndpZHRoID0gXCIwcHhcIjtcbiAgICBpZiAoIXdlYmtpdCkgZC5zY3JvbGxlci5kcmFnZ2FibGUgPSB0cnVlO1xuICAgIC8vIE5lZWRlZCB0byBoYW5kbGUgVGFiIGtleSBpbiBLSFRNTFxuICAgIGlmIChraHRtbCkgeyBkLmlucHV0RGl2LnN0eWxlLmhlaWdodCA9IFwiMXB4XCI7IGQuaW5wdXREaXYuc3R5bGUucG9zaXRpb24gPSBcImFic29sdXRlXCI7IH1cbiAgICAvLyBOZWVkIHRvIHNldCBhIG1pbmltdW0gd2lkdGggdG8gc2VlIHRoZSBzY3JvbGxiYXIgb24gSUU3IChidXQgbXVzdCBub3Qgc2V0IGl0IG9uIElFOCkuXG4gICAgZWxzZSBpZiAoaWVfbHQ4KSBkLnNjcm9sbGJhckguc3R5bGUubWluV2lkdGggPSBkLnNjcm9sbGJhclYuc3R5bGUubWluV2lkdGggPSBcIjE4cHhcIjtcblxuICAgIC8vIEN1cnJlbnQgdmlzaWJsZSByYW5nZSAobWF5IGJlIGJpZ2dlciB0aGFuIHRoZSB2aWV3IHdpbmRvdykuXG4gICAgZC52aWV3T2Zmc2V0ID0gZC5sYXN0U2l6ZUMgPSAwO1xuICAgIGQuc2hvd2luZ0Zyb20gPSBkLnNob3dpbmdUbyA9IGRvY1N0YXJ0O1xuXG4gICAgLy8gVXNlZCB0byBvbmx5IHJlc2l6ZSB0aGUgbGluZSBudW1iZXIgZ3V0dGVyIHdoZW4gbmVjZXNzYXJ5ICh3aGVuXG4gICAgLy8gdGhlIGFtb3VudCBvZiBsaW5lcyBjcm9zc2VzIGEgYm91bmRhcnkgdGhhdCBtYWtlcyBpdHMgd2lkdGggY2hhbmdlKVxuICAgIGQubGluZU51bVdpZHRoID0gZC5saW5lTnVtSW5uZXJXaWR0aCA9IGQubGluZU51bUNoYXJzID0gbnVsbDtcbiAgICAvLyBTZWUgcmVhZElucHV0IGFuZCByZXNldElucHV0XG4gICAgZC5wcmV2SW5wdXQgPSBcIlwiO1xuICAgIC8vIFNldCB0byB0cnVlIHdoZW4gYSBub24taG9yaXpvbnRhbC1zY3JvbGxpbmcgd2lkZ2V0IGlzIGFkZGVkLiBBc1xuICAgIC8vIGFuIG9wdGltaXphdGlvbiwgd2lkZ2V0IGFsaWduaW5nIGlzIHNraXBwZWQgd2hlbiBkIGlzIGZhbHNlLlxuICAgIGQuYWxpZ25XaWRnZXRzID0gZmFsc2U7XG4gICAgLy8gRmxhZyB0aGF0IGluZGljYXRlcyB3aGV0aGVyIHdlIGN1cnJlbnRseSBleHBlY3QgaW5wdXQgdG8gYXBwZWFyXG4gICAgLy8gKGFmdGVyIHNvbWUgZXZlbnQgbGlrZSAna2V5cHJlc3MnIG9yICdpbnB1dCcpIGFuZCBhcmUgcG9sbGluZ1xuICAgIC8vIGludGVuc2l2ZWx5LlxuICAgIGQucG9sbGluZ0Zhc3QgPSBmYWxzZTtcbiAgICAvLyBTZWxmLXJlc2V0dGluZyB0aW1lb3V0IGZvciB0aGUgcG9sbGVyXG4gICAgZC5wb2xsID0gbmV3IERlbGF5ZWQoKTtcblxuICAgIGQuY2FjaGVkQ2hhcldpZHRoID0gZC5jYWNoZWRUZXh0SGVpZ2h0ID0gZC5jYWNoZWRQYWRkaW5nSCA9IG51bGw7XG4gICAgZC5tZWFzdXJlTGluZUNhY2hlID0gW107XG4gICAgZC5tZWFzdXJlTGluZUNhY2hlUG9zID0gMDtcblxuICAgIC8vIFRyYWNrcyB3aGVuIHJlc2V0SW5wdXQgaGFzIHB1bnRlZCB0byBqdXN0IHB1dHRpbmcgYSBzaG9ydFxuICAgIC8vIHN0cmluZyBpbnN0ZWFkIG9mIHRoZSAobGFyZ2UpIHNlbGVjdGlvbi5cbiAgICBkLmluYWNjdXJhdGVTZWxlY3Rpb24gPSBmYWxzZTtcblxuICAgIC8vIFRyYWNrcyB0aGUgbWF4aW11bSBsaW5lIGxlbmd0aCBzbyB0aGF0IHRoZSBob3Jpem9udGFsIHNjcm9sbGJhclxuICAgIC8vIGNhbiBiZSBrZXB0IHN0YXRpYyB3aGVuIHNjcm9sbGluZy5cbiAgICBkLm1heExpbmUgPSBudWxsO1xuICAgIGQubWF4TGluZUxlbmd0aCA9IDA7XG4gICAgZC5tYXhMaW5lQ2hhbmdlZCA9IGZhbHNlO1xuXG4gICAgLy8gVXNlZCBmb3IgbWVhc3VyaW5nIHdoZWVsIHNjcm9sbGluZyBncmFudWxhcml0eVxuICAgIGQud2hlZWxEWCA9IGQud2hlZWxEWSA9IGQud2hlZWxTdGFydFggPSBkLndoZWVsU3RhcnRZID0gbnVsbDtcblxuICAgIHJldHVybiBkO1xuICB9XG5cbiAgLy8gU1RBVEUgVVBEQVRFU1xuXG4gIC8vIFVzZWQgdG8gZ2V0IHRoZSBlZGl0b3IgaW50byBhIGNvbnNpc3RlbnQgc3RhdGUgYWdhaW4gd2hlbiBvcHRpb25zIGNoYW5nZS5cblxuICBmdW5jdGlvbiBsb2FkTW9kZShjbSkge1xuICAgIGNtLmRvYy5tb2RlID0gQ29kZU1pcnJvci5nZXRNb2RlKGNtLm9wdGlvbnMsIGNtLmRvYy5tb2RlT3B0aW9uKTtcbiAgICByZXNldE1vZGVTdGF0ZShjbSk7XG4gIH1cblxuICBmdW5jdGlvbiByZXNldE1vZGVTdGF0ZShjbSkge1xuICAgIGNtLmRvYy5pdGVyKGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgIGlmIChsaW5lLnN0YXRlQWZ0ZXIpIGxpbmUuc3RhdGVBZnRlciA9IG51bGw7XG4gICAgICBpZiAobGluZS5zdHlsZXMpIGxpbmUuc3R5bGVzID0gbnVsbDtcbiAgICB9KTtcbiAgICBjbS5kb2MuZnJvbnRpZXIgPSBjbS5kb2MuZmlyc3Q7XG4gICAgc3RhcnRXb3JrZXIoY20sIDEwMCk7XG4gICAgY20uc3RhdGUubW9kZUdlbisrO1xuICAgIGlmIChjbS5jdXJPcCkgcmVnQ2hhbmdlKGNtKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHdyYXBwaW5nQ2hhbmdlZChjbSkge1xuICAgIGlmIChjbS5vcHRpb25zLmxpbmVXcmFwcGluZykge1xuICAgICAgY20uZGlzcGxheS53cmFwcGVyLmNsYXNzTmFtZSArPSBcIiBDb2RlTWlycm9yLXdyYXBcIjtcbiAgICAgIGNtLmRpc3BsYXkuc2l6ZXIuc3R5bGUubWluV2lkdGggPSBcIlwiO1xuICAgIH0gZWxzZSB7XG4gICAgICBjbS5kaXNwbGF5LndyYXBwZXIuY2xhc3NOYW1lID0gY20uZGlzcGxheS53cmFwcGVyLmNsYXNzTmFtZS5yZXBsYWNlKFwiIENvZGVNaXJyb3Itd3JhcFwiLCBcIlwiKTtcbiAgICAgIGNvbXB1dGVNYXhMZW5ndGgoY20pO1xuICAgIH1cbiAgICBlc3RpbWF0ZUxpbmVIZWlnaHRzKGNtKTtcbiAgICByZWdDaGFuZ2UoY20pO1xuICAgIGNsZWFyQ2FjaGVzKGNtKTtcbiAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCl7dXBkYXRlU2Nyb2xsYmFycyhjbSk7fSwgMTAwKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGVzdGltYXRlSGVpZ2h0KGNtKSB7XG4gICAgdmFyIHRoID0gdGV4dEhlaWdodChjbS5kaXNwbGF5KSwgd3JhcHBpbmcgPSBjbS5vcHRpb25zLmxpbmVXcmFwcGluZztcbiAgICB2YXIgcGVyTGluZSA9IHdyYXBwaW5nICYmIE1hdGgubWF4KDUsIGNtLmRpc3BsYXkuc2Nyb2xsZXIuY2xpZW50V2lkdGggLyBjaGFyV2lkdGgoY20uZGlzcGxheSkgLSAzKTtcbiAgICByZXR1cm4gZnVuY3Rpb24obGluZSkge1xuICAgICAgaWYgKGxpbmVJc0hpZGRlbihjbS5kb2MsIGxpbmUpKVxuICAgICAgICByZXR1cm4gMDtcbiAgICAgIGVsc2UgaWYgKHdyYXBwaW5nKVxuICAgICAgICByZXR1cm4gKE1hdGguY2VpbChsaW5lLnRleHQubGVuZ3RoIC8gcGVyTGluZSkgfHwgMSkgKiB0aDtcbiAgICAgIGVsc2VcbiAgICAgICAgcmV0dXJuIHRoO1xuICAgIH07XG4gIH1cblxuICBmdW5jdGlvbiBlc3RpbWF0ZUxpbmVIZWlnaHRzKGNtKSB7XG4gICAgdmFyIGRvYyA9IGNtLmRvYywgZXN0ID0gZXN0aW1hdGVIZWlnaHQoY20pO1xuICAgIGRvYy5pdGVyKGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgIHZhciBlc3RIZWlnaHQgPSBlc3QobGluZSk7XG4gICAgICBpZiAoZXN0SGVpZ2h0ICE9IGxpbmUuaGVpZ2h0KSB1cGRhdGVMaW5lSGVpZ2h0KGxpbmUsIGVzdEhlaWdodCk7XG4gICAgfSk7XG4gIH1cblxuICBmdW5jdGlvbiBrZXlNYXBDaGFuZ2VkKGNtKSB7XG4gICAgdmFyIG1hcCA9IGtleU1hcFtjbS5vcHRpb25zLmtleU1hcF0sIHN0eWxlID0gbWFwLnN0eWxlO1xuICAgIGNtLmRpc3BsYXkud3JhcHBlci5jbGFzc05hbWUgPSBjbS5kaXNwbGF5LndyYXBwZXIuY2xhc3NOYW1lLnJlcGxhY2UoL1xccypjbS1rZXltYXAtXFxTKy9nLCBcIlwiKSArXG4gICAgICAoc3R5bGUgPyBcIiBjbS1rZXltYXAtXCIgKyBzdHlsZSA6IFwiXCIpO1xuICB9XG5cbiAgZnVuY3Rpb24gdGhlbWVDaGFuZ2VkKGNtKSB7XG4gICAgY20uZGlzcGxheS53cmFwcGVyLmNsYXNzTmFtZSA9IGNtLmRpc3BsYXkud3JhcHBlci5jbGFzc05hbWUucmVwbGFjZSgvXFxzKmNtLXMtXFxTKy9nLCBcIlwiKSArXG4gICAgICBjbS5vcHRpb25zLnRoZW1lLnJlcGxhY2UoLyhefFxccylcXHMqL2csIFwiIGNtLXMtXCIpO1xuICAgIGNsZWFyQ2FjaGVzKGNtKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGd1dHRlcnNDaGFuZ2VkKGNtKSB7XG4gICAgdXBkYXRlR3V0dGVycyhjbSk7XG4gICAgcmVnQ2hhbmdlKGNtKTtcbiAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCl7YWxpZ25Ib3Jpem9udGFsbHkoY20pO30sIDIwKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHVwZGF0ZUd1dHRlcnMoY20pIHtcbiAgICB2YXIgZ3V0dGVycyA9IGNtLmRpc3BsYXkuZ3V0dGVycywgc3BlY3MgPSBjbS5vcHRpb25zLmd1dHRlcnM7XG4gICAgcmVtb3ZlQ2hpbGRyZW4oZ3V0dGVycyk7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBzcGVjcy5sZW5ndGg7ICsraSkge1xuICAgICAgdmFyIGd1dHRlckNsYXNzID0gc3BlY3NbaV07XG4gICAgICB2YXIgZ0VsdCA9IGd1dHRlcnMuYXBwZW5kQ2hpbGQoZWx0KFwiZGl2XCIsIG51bGwsIFwiQ29kZU1pcnJvci1ndXR0ZXIgXCIgKyBndXR0ZXJDbGFzcykpO1xuICAgICAgaWYgKGd1dHRlckNsYXNzID09IFwiQ29kZU1pcnJvci1saW5lbnVtYmVyc1wiKSB7XG4gICAgICAgIGNtLmRpc3BsYXkubGluZUd1dHRlciA9IGdFbHQ7XG4gICAgICAgIGdFbHQuc3R5bGUud2lkdGggPSAoY20uZGlzcGxheS5saW5lTnVtV2lkdGggfHwgMSkgKyBcInB4XCI7XG4gICAgICB9XG4gICAgfVxuICAgIGd1dHRlcnMuc3R5bGUuZGlzcGxheSA9IGkgPyBcIlwiIDogXCJub25lXCI7XG4gIH1cblxuICBmdW5jdGlvbiBsaW5lTGVuZ3RoKGRvYywgbGluZSkge1xuICAgIGlmIChsaW5lLmhlaWdodCA9PSAwKSByZXR1cm4gMDtcbiAgICB2YXIgbGVuID0gbGluZS50ZXh0Lmxlbmd0aCwgbWVyZ2VkLCBjdXIgPSBsaW5lO1xuICAgIHdoaWxlIChtZXJnZWQgPSBjb2xsYXBzZWRTcGFuQXRTdGFydChjdXIpKSB7XG4gICAgICB2YXIgZm91bmQgPSBtZXJnZWQuZmluZCgpO1xuICAgICAgY3VyID0gZ2V0TGluZShkb2MsIGZvdW5kLmZyb20ubGluZSk7XG4gICAgICBsZW4gKz0gZm91bmQuZnJvbS5jaCAtIGZvdW5kLnRvLmNoO1xuICAgIH1cbiAgICBjdXIgPSBsaW5lO1xuICAgIHdoaWxlIChtZXJnZWQgPSBjb2xsYXBzZWRTcGFuQXRFbmQoY3VyKSkge1xuICAgICAgdmFyIGZvdW5kID0gbWVyZ2VkLmZpbmQoKTtcbiAgICAgIGxlbiAtPSBjdXIudGV4dC5sZW5ndGggLSBmb3VuZC5mcm9tLmNoO1xuICAgICAgY3VyID0gZ2V0TGluZShkb2MsIGZvdW5kLnRvLmxpbmUpO1xuICAgICAgbGVuICs9IGN1ci50ZXh0Lmxlbmd0aCAtIGZvdW5kLnRvLmNoO1xuICAgIH1cbiAgICByZXR1cm4gbGVuO1xuICB9XG5cbiAgZnVuY3Rpb24gY29tcHV0ZU1heExlbmd0aChjbSkge1xuICAgIHZhciBkID0gY20uZGlzcGxheSwgZG9jID0gY20uZG9jO1xuICAgIGQubWF4TGluZSA9IGdldExpbmUoZG9jLCBkb2MuZmlyc3QpO1xuICAgIGQubWF4TGluZUxlbmd0aCA9IGxpbmVMZW5ndGgoZG9jLCBkLm1heExpbmUpO1xuICAgIGQubWF4TGluZUNoYW5nZWQgPSB0cnVlO1xuICAgIGRvYy5pdGVyKGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgIHZhciBsZW4gPSBsaW5lTGVuZ3RoKGRvYywgbGluZSk7XG4gICAgICBpZiAobGVuID4gZC5tYXhMaW5lTGVuZ3RoKSB7XG4gICAgICAgIGQubWF4TGluZUxlbmd0aCA9IGxlbjtcbiAgICAgICAgZC5tYXhMaW5lID0gbGluZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIC8vIE1ha2Ugc3VyZSB0aGUgZ3V0dGVycyBvcHRpb25zIGNvbnRhaW5zIHRoZSBlbGVtZW50XG4gIC8vIFwiQ29kZU1pcnJvci1saW5lbnVtYmVyc1wiIHdoZW4gdGhlIGxpbmVOdW1iZXJzIG9wdGlvbiBpcyB0cnVlLlxuICBmdW5jdGlvbiBzZXRHdXR0ZXJzRm9yTGluZU51bWJlcnMob3B0aW9ucykge1xuICAgIHZhciBmb3VuZCA9IGluZGV4T2Yob3B0aW9ucy5ndXR0ZXJzLCBcIkNvZGVNaXJyb3ItbGluZW51bWJlcnNcIik7XG4gICAgaWYgKGZvdW5kID09IC0xICYmIG9wdGlvbnMubGluZU51bWJlcnMpIHtcbiAgICAgIG9wdGlvbnMuZ3V0dGVycyA9IG9wdGlvbnMuZ3V0dGVycy5jb25jYXQoW1wiQ29kZU1pcnJvci1saW5lbnVtYmVyc1wiXSk7XG4gICAgfSBlbHNlIGlmIChmb3VuZCA+IC0xICYmICFvcHRpb25zLmxpbmVOdW1iZXJzKSB7XG4gICAgICBvcHRpb25zLmd1dHRlcnMgPSBvcHRpb25zLmd1dHRlcnMuc2xpY2UoMCk7XG4gICAgICBvcHRpb25zLmd1dHRlcnMuc3BsaWNlKGZvdW5kLCAxKTtcbiAgICB9XG4gIH1cblxuICAvLyBTQ1JPTExCQVJTXG5cbiAgLy8gUmUtc3luY2hyb25pemUgdGhlIGZha2Ugc2Nyb2xsYmFycyB3aXRoIHRoZSBhY3R1YWwgc2l6ZSBvZiB0aGVcbiAgLy8gY29udGVudC4gT3B0aW9uYWxseSBmb3JjZSBhIHNjcm9sbFRvcC5cbiAgZnVuY3Rpb24gdXBkYXRlU2Nyb2xsYmFycyhjbSkge1xuICAgIHZhciBkID0gY20uZGlzcGxheSwgZG9jSGVpZ2h0ID0gY20uZG9jLmhlaWdodDtcbiAgICB2YXIgdG90YWxIZWlnaHQgPSBkb2NIZWlnaHQgKyBwYWRkaW5nVmVydChkKTtcbiAgICBkLnNpemVyLnN0eWxlLm1pbkhlaWdodCA9IGQuaGVpZ2h0Rm9yY2VyLnN0eWxlLnRvcCA9IHRvdGFsSGVpZ2h0ICsgXCJweFwiO1xuICAgIGQuZ3V0dGVycy5zdHlsZS5oZWlnaHQgPSBNYXRoLm1heCh0b3RhbEhlaWdodCwgZC5zY3JvbGxlci5jbGllbnRIZWlnaHQgLSBzY3JvbGxlckN1dE9mZikgKyBcInB4XCI7XG4gICAgdmFyIHNjcm9sbEhlaWdodCA9IE1hdGgubWF4KHRvdGFsSGVpZ2h0LCBkLnNjcm9sbGVyLnNjcm9sbEhlaWdodCk7XG4gICAgdmFyIG5lZWRzSCA9IGQuc2Nyb2xsZXIuc2Nyb2xsV2lkdGggPiAoZC5zY3JvbGxlci5jbGllbnRXaWR0aCArIDEpO1xuICAgIHZhciBuZWVkc1YgPSBzY3JvbGxIZWlnaHQgPiAoZC5zY3JvbGxlci5jbGllbnRIZWlnaHQgKyAxKTtcbiAgICBpZiAobmVlZHNWKSB7XG4gICAgICBkLnNjcm9sbGJhclYuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbiAgICAgIGQuc2Nyb2xsYmFyVi5zdHlsZS5ib3R0b20gPSBuZWVkc0ggPyBzY3JvbGxiYXJXaWR0aChkLm1lYXN1cmUpICsgXCJweFwiIDogXCIwXCI7XG4gICAgICAvLyBBIGJ1ZyBpbiBJRTggY2FuIGNhdXNlIHRoaXMgdmFsdWUgdG8gYmUgbmVnYXRpdmUsIHNvIGd1YXJkIGl0LlxuICAgICAgZC5zY3JvbGxiYXJWLmZpcnN0Q2hpbGQuc3R5bGUuaGVpZ2h0ID1cbiAgICAgICAgTWF0aC5tYXgoMCwgc2Nyb2xsSGVpZ2h0IC0gZC5zY3JvbGxlci5jbGllbnRIZWlnaHQgKyBkLnNjcm9sbGJhclYuY2xpZW50SGVpZ2h0KSArIFwicHhcIjtcbiAgICB9IGVsc2Uge1xuICAgICAgZC5zY3JvbGxiYXJWLnN0eWxlLmRpc3BsYXkgPSBcIlwiO1xuICAgICAgZC5zY3JvbGxiYXJWLmZpcnN0Q2hpbGQuc3R5bGUuaGVpZ2h0ID0gXCIwXCI7XG4gICAgfVxuICAgIGlmIChuZWVkc0gpIHtcbiAgICAgIGQuc2Nyb2xsYmFySC5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xuICAgICAgZC5zY3JvbGxiYXJILnN0eWxlLnJpZ2h0ID0gbmVlZHNWID8gc2Nyb2xsYmFyV2lkdGgoZC5tZWFzdXJlKSArIFwicHhcIiA6IFwiMFwiO1xuICAgICAgZC5zY3JvbGxiYXJILmZpcnN0Q2hpbGQuc3R5bGUud2lkdGggPVxuICAgICAgICAoZC5zY3JvbGxlci5zY3JvbGxXaWR0aCAtIGQuc2Nyb2xsZXIuY2xpZW50V2lkdGggKyBkLnNjcm9sbGJhckguY2xpZW50V2lkdGgpICsgXCJweFwiO1xuICAgIH0gZWxzZSB7XG4gICAgICBkLnNjcm9sbGJhckguc3R5bGUuZGlzcGxheSA9IFwiXCI7XG4gICAgICBkLnNjcm9sbGJhckguZmlyc3RDaGlsZC5zdHlsZS53aWR0aCA9IFwiMFwiO1xuICAgIH1cbiAgICBpZiAobmVlZHNIICYmIG5lZWRzVikge1xuICAgICAgZC5zY3JvbGxiYXJGaWxsZXIuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbiAgICAgIGQuc2Nyb2xsYmFyRmlsbGVyLnN0eWxlLmhlaWdodCA9IGQuc2Nyb2xsYmFyRmlsbGVyLnN0eWxlLndpZHRoID0gc2Nyb2xsYmFyV2lkdGgoZC5tZWFzdXJlKSArIFwicHhcIjtcbiAgICB9IGVsc2UgZC5zY3JvbGxiYXJGaWxsZXIuc3R5bGUuZGlzcGxheSA9IFwiXCI7XG4gICAgaWYgKG5lZWRzSCAmJiBjbS5vcHRpb25zLmNvdmVyR3V0dGVyTmV4dFRvU2Nyb2xsYmFyICYmIGNtLm9wdGlvbnMuZml4ZWRHdXR0ZXIpIHtcbiAgICAgIGQuZ3V0dGVyRmlsbGVyLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG4gICAgICBkLmd1dHRlckZpbGxlci5zdHlsZS5oZWlnaHQgPSBzY3JvbGxiYXJXaWR0aChkLm1lYXN1cmUpICsgXCJweFwiO1xuICAgICAgZC5ndXR0ZXJGaWxsZXIuc3R5bGUud2lkdGggPSBkLmd1dHRlcnMub2Zmc2V0V2lkdGggKyBcInB4XCI7XG4gICAgfSBlbHNlIGQuZ3V0dGVyRmlsbGVyLnN0eWxlLmRpc3BsYXkgPSBcIlwiO1xuXG4gICAgaWYgKG1hY19nZUxpb24gJiYgc2Nyb2xsYmFyV2lkdGgoZC5tZWFzdXJlKSA9PT0gMCkge1xuICAgICAgZC5zY3JvbGxiYXJWLnN0eWxlLm1pbldpZHRoID0gZC5zY3JvbGxiYXJILnN0eWxlLm1pbkhlaWdodCA9IG1hY19nZU1vdW50YWluTGlvbiA/IFwiMThweFwiIDogXCIxMnB4XCI7XG4gICAgICBkLnNjcm9sbGJhclYuc3R5bGUucG9pbnRlckV2ZW50cyA9IGQuc2Nyb2xsYmFySC5zdHlsZS5wb2ludGVyRXZlbnRzID0gXCJub25lXCI7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gdmlzaWJsZUxpbmVzKGRpc3BsYXksIGRvYywgdmlld1BvcnQpIHtcbiAgICB2YXIgdG9wID0gZGlzcGxheS5zY3JvbGxlci5zY3JvbGxUb3AsIGhlaWdodCA9IGRpc3BsYXkud3JhcHBlci5jbGllbnRIZWlnaHQ7XG4gICAgaWYgKHR5cGVvZiB2aWV3UG9ydCA9PSBcIm51bWJlclwiKSB0b3AgPSB2aWV3UG9ydDtcbiAgICBlbHNlIGlmICh2aWV3UG9ydCkge3RvcCA9IHZpZXdQb3J0LnRvcDsgaGVpZ2h0ID0gdmlld1BvcnQuYm90dG9tIC0gdmlld1BvcnQudG9wO31cbiAgICB0b3AgPSBNYXRoLmZsb29yKHRvcCAtIHBhZGRpbmdUb3AoZGlzcGxheSkpO1xuICAgIHZhciBib3R0b20gPSBNYXRoLmNlaWwodG9wICsgaGVpZ2h0KTtcbiAgICByZXR1cm4ge2Zyb206IGxpbmVBdEhlaWdodChkb2MsIHRvcCksIHRvOiBsaW5lQXRIZWlnaHQoZG9jLCBib3R0b20pfTtcbiAgfVxuXG4gIC8vIExJTkUgTlVNQkVSU1xuXG4gIGZ1bmN0aW9uIGFsaWduSG9yaXpvbnRhbGx5KGNtKSB7XG4gICAgdmFyIGRpc3BsYXkgPSBjbS5kaXNwbGF5O1xuICAgIGlmICghZGlzcGxheS5hbGlnbldpZGdldHMgJiYgKCFkaXNwbGF5Lmd1dHRlcnMuZmlyc3RDaGlsZCB8fCAhY20ub3B0aW9ucy5maXhlZEd1dHRlcikpIHJldHVybjtcbiAgICB2YXIgY29tcCA9IGNvbXBlbnNhdGVGb3JIU2Nyb2xsKGRpc3BsYXkpIC0gZGlzcGxheS5zY3JvbGxlci5zY3JvbGxMZWZ0ICsgY20uZG9jLnNjcm9sbExlZnQ7XG4gICAgdmFyIGd1dHRlclcgPSBkaXNwbGF5Lmd1dHRlcnMub2Zmc2V0V2lkdGgsIGwgPSBjb21wICsgXCJweFwiO1xuICAgIGZvciAodmFyIG4gPSBkaXNwbGF5LmxpbmVEaXYuZmlyc3RDaGlsZDsgbjsgbiA9IG4ubmV4dFNpYmxpbmcpIGlmIChuLmFsaWduYWJsZSkge1xuICAgICAgZm9yICh2YXIgaSA9IDAsIGEgPSBuLmFsaWduYWJsZTsgaSA8IGEubGVuZ3RoOyArK2kpIGFbaV0uc3R5bGUubGVmdCA9IGw7XG4gICAgfVxuICAgIGlmIChjbS5vcHRpb25zLmZpeGVkR3V0dGVyKVxuICAgICAgZGlzcGxheS5ndXR0ZXJzLnN0eWxlLmxlZnQgPSAoY29tcCArIGd1dHRlclcpICsgXCJweFwiO1xuICB9XG5cbiAgZnVuY3Rpb24gbWF5YmVVcGRhdGVMaW5lTnVtYmVyV2lkdGgoY20pIHtcbiAgICBpZiAoIWNtLm9wdGlvbnMubGluZU51bWJlcnMpIHJldHVybiBmYWxzZTtcbiAgICB2YXIgZG9jID0gY20uZG9jLCBsYXN0ID0gbGluZU51bWJlckZvcihjbS5vcHRpb25zLCBkb2MuZmlyc3QgKyBkb2Muc2l6ZSAtIDEpLCBkaXNwbGF5ID0gY20uZGlzcGxheTtcbiAgICBpZiAobGFzdC5sZW5ndGggIT0gZGlzcGxheS5saW5lTnVtQ2hhcnMpIHtcbiAgICAgIHZhciB0ZXN0ID0gZGlzcGxheS5tZWFzdXJlLmFwcGVuZENoaWxkKGVsdChcImRpdlwiLCBbZWx0KFwiZGl2XCIsIGxhc3QpXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIkNvZGVNaXJyb3ItbGluZW51bWJlciBDb2RlTWlycm9yLWd1dHRlci1lbHRcIikpO1xuICAgICAgdmFyIGlubmVyVyA9IHRlc3QuZmlyc3RDaGlsZC5vZmZzZXRXaWR0aCwgcGFkZGluZyA9IHRlc3Qub2Zmc2V0V2lkdGggLSBpbm5lclc7XG4gICAgICBkaXNwbGF5LmxpbmVHdXR0ZXIuc3R5bGUud2lkdGggPSBcIlwiO1xuICAgICAgZGlzcGxheS5saW5lTnVtSW5uZXJXaWR0aCA9IE1hdGgubWF4KGlubmVyVywgZGlzcGxheS5saW5lR3V0dGVyLm9mZnNldFdpZHRoIC0gcGFkZGluZyk7XG4gICAgICBkaXNwbGF5LmxpbmVOdW1XaWR0aCA9IGRpc3BsYXkubGluZU51bUlubmVyV2lkdGggKyBwYWRkaW5nO1xuICAgICAgZGlzcGxheS5saW5lTnVtQ2hhcnMgPSBkaXNwbGF5LmxpbmVOdW1Jbm5lcldpZHRoID8gbGFzdC5sZW5ndGggOiAtMTtcbiAgICAgIGRpc3BsYXkubGluZUd1dHRlci5zdHlsZS53aWR0aCA9IGRpc3BsYXkubGluZU51bVdpZHRoICsgXCJweFwiO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGxpbmVOdW1iZXJGb3Iob3B0aW9ucywgaSkge1xuICAgIHJldHVybiBTdHJpbmcob3B0aW9ucy5saW5lTnVtYmVyRm9ybWF0dGVyKGkgKyBvcHRpb25zLmZpcnN0TGluZU51bWJlcikpO1xuICB9XG4gIGZ1bmN0aW9uIGNvbXBlbnNhdGVGb3JIU2Nyb2xsKGRpc3BsYXkpIHtcbiAgICByZXR1cm4gZ2V0UmVjdChkaXNwbGF5LnNjcm9sbGVyKS5sZWZ0IC0gZ2V0UmVjdChkaXNwbGF5LnNpemVyKS5sZWZ0O1xuICB9XG5cbiAgLy8gRElTUExBWSBEUkFXSU5HXG5cbiAgZnVuY3Rpb24gdXBkYXRlRGlzcGxheShjbSwgY2hhbmdlcywgdmlld1BvcnQsIGZvcmNlZCkge1xuICAgIHZhciBvbGRGcm9tID0gY20uZGlzcGxheS5zaG93aW5nRnJvbSwgb2xkVG8gPSBjbS5kaXNwbGF5LnNob3dpbmdUbywgdXBkYXRlZDtcbiAgICB2YXIgdmlzaWJsZSA9IHZpc2libGVMaW5lcyhjbS5kaXNwbGF5LCBjbS5kb2MsIHZpZXdQb3J0KTtcbiAgICBmb3IgKHZhciBmaXJzdCA9IHRydWU7OyBmaXJzdCA9IGZhbHNlKSB7XG4gICAgICB2YXIgb2xkV2lkdGggPSBjbS5kaXNwbGF5LnNjcm9sbGVyLmNsaWVudFdpZHRoO1xuICAgICAgaWYgKCF1cGRhdGVEaXNwbGF5SW5uZXIoY20sIGNoYW5nZXMsIHZpc2libGUsIGZvcmNlZCkpIGJyZWFrO1xuICAgICAgdXBkYXRlZCA9IHRydWU7XG4gICAgICBjaGFuZ2VzID0gW107XG4gICAgICB1cGRhdGVTZWxlY3Rpb24oY20pO1xuICAgICAgdXBkYXRlU2Nyb2xsYmFycyhjbSk7XG4gICAgICBpZiAoZmlyc3QgJiYgY20ub3B0aW9ucy5saW5lV3JhcHBpbmcgJiYgb2xkV2lkdGggIT0gY20uZGlzcGxheS5zY3JvbGxlci5jbGllbnRXaWR0aCkge1xuICAgICAgICBmb3JjZWQgPSB0cnVlO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGZvcmNlZCA9IGZhbHNlO1xuXG4gICAgICAvLyBDbGlwIGZvcmNlZCB2aWV3cG9ydCB0byBhY3R1YWwgc2Nyb2xsYWJsZSBhcmVhXG4gICAgICBpZiAodmlld1BvcnQpXG4gICAgICAgIHZpZXdQb3J0ID0gTWF0aC5taW4oY20uZGlzcGxheS5zY3JvbGxlci5zY3JvbGxIZWlnaHQgLSBjbS5kaXNwbGF5LnNjcm9sbGVyLmNsaWVudEhlaWdodCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlb2Ygdmlld1BvcnQgPT0gXCJudW1iZXJcIiA/IHZpZXdQb3J0IDogdmlld1BvcnQudG9wKTtcbiAgICAgIHZpc2libGUgPSB2aXNpYmxlTGluZXMoY20uZGlzcGxheSwgY20uZG9jLCB2aWV3UG9ydCk7XG4gICAgICBpZiAodmlzaWJsZS5mcm9tID49IGNtLmRpc3BsYXkuc2hvd2luZ0Zyb20gJiYgdmlzaWJsZS50byA8PSBjbS5kaXNwbGF5LnNob3dpbmdUbylcbiAgICAgICAgYnJlYWs7XG4gICAgfVxuXG4gICAgaWYgKHVwZGF0ZWQpIHtcbiAgICAgIHNpZ25hbExhdGVyKGNtLCBcInVwZGF0ZVwiLCBjbSk7XG4gICAgICBpZiAoY20uZGlzcGxheS5zaG93aW5nRnJvbSAhPSBvbGRGcm9tIHx8IGNtLmRpc3BsYXkuc2hvd2luZ1RvICE9IG9sZFRvKVxuICAgICAgICBzaWduYWxMYXRlcihjbSwgXCJ2aWV3cG9ydENoYW5nZVwiLCBjbSwgY20uZGlzcGxheS5zaG93aW5nRnJvbSwgY20uZGlzcGxheS5zaG93aW5nVG8pO1xuICAgIH1cbiAgICByZXR1cm4gdXBkYXRlZDtcbiAgfVxuXG4gIC8vIFVzZXMgYSBzZXQgb2YgY2hhbmdlcyBwbHVzIHRoZSBjdXJyZW50IHNjcm9sbCBwb3NpdGlvbiB0b1xuICAvLyBkZXRlcm1pbmUgd2hpY2ggRE9NIHVwZGF0ZXMgaGF2ZSB0byBiZSBtYWRlLCBhbmQgbWFrZXMgdGhlXG4gIC8vIHVwZGF0ZXMuXG4gIGZ1bmN0aW9uIHVwZGF0ZURpc3BsYXlJbm5lcihjbSwgY2hhbmdlcywgdmlzaWJsZSwgZm9yY2VkKSB7XG4gICAgdmFyIGRpc3BsYXkgPSBjbS5kaXNwbGF5LCBkb2MgPSBjbS5kb2M7XG4gICAgaWYgKCFkaXNwbGF5LndyYXBwZXIub2Zmc2V0V2lkdGgpIHtcbiAgICAgIGRpc3BsYXkuc2hvd2luZ0Zyb20gPSBkaXNwbGF5LnNob3dpbmdUbyA9IGRvYy5maXJzdDtcbiAgICAgIGRpc3BsYXkudmlld09mZnNldCA9IDA7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gQmFpbCBvdXQgaWYgdGhlIHZpc2libGUgYXJlYSBpcyBhbHJlYWR5IHJlbmRlcmVkIGFuZCBub3RoaW5nIGNoYW5nZWQuXG4gICAgaWYgKCFmb3JjZWQgJiYgY2hhbmdlcy5sZW5ndGggPT0gMCAmJlxuICAgICAgICB2aXNpYmxlLmZyb20gPiBkaXNwbGF5LnNob3dpbmdGcm9tICYmIHZpc2libGUudG8gPCBkaXNwbGF5LnNob3dpbmdUbylcbiAgICAgIHJldHVybjtcblxuICAgIGlmIChtYXliZVVwZGF0ZUxpbmVOdW1iZXJXaWR0aChjbSkpXG4gICAgICBjaGFuZ2VzID0gW3tmcm9tOiBkb2MuZmlyc3QsIHRvOiBkb2MuZmlyc3QgKyBkb2Muc2l6ZX1dO1xuICAgIHZhciBndXR0ZXJXID0gZGlzcGxheS5zaXplci5zdHlsZS5tYXJnaW5MZWZ0ID0gZGlzcGxheS5ndXR0ZXJzLm9mZnNldFdpZHRoICsgXCJweFwiO1xuICAgIGRpc3BsYXkuc2Nyb2xsYmFySC5zdHlsZS5sZWZ0ID0gY20ub3B0aW9ucy5maXhlZEd1dHRlciA/IGd1dHRlclcgOiBcIjBcIjtcblxuICAgIC8vIFVzZWQgdG8gZGV0ZXJtaW5lIHdoaWNoIGxpbmVzIG5lZWQgdGhlaXIgbGluZSBudW1iZXJzIHVwZGF0ZWRcbiAgICB2YXIgcG9zaXRpb25zQ2hhbmdlZEZyb20gPSBJbmZpbml0eTtcbiAgICBpZiAoY20ub3B0aW9ucy5saW5lTnVtYmVycylcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgY2hhbmdlcy5sZW5ndGg7ICsraSlcbiAgICAgICAgaWYgKGNoYW5nZXNbaV0uZGlmZiAmJiBjaGFuZ2VzW2ldLmZyb20gPCBwb3NpdGlvbnNDaGFuZ2VkRnJvbSkgeyBwb3NpdGlvbnNDaGFuZ2VkRnJvbSA9IGNoYW5nZXNbaV0uZnJvbTsgfVxuXG4gICAgdmFyIGVuZCA9IGRvYy5maXJzdCArIGRvYy5zaXplO1xuICAgIHZhciBmcm9tID0gTWF0aC5tYXgodmlzaWJsZS5mcm9tIC0gY20ub3B0aW9ucy52aWV3cG9ydE1hcmdpbiwgZG9jLmZpcnN0KTtcbiAgICB2YXIgdG8gPSBNYXRoLm1pbihlbmQsIHZpc2libGUudG8gKyBjbS5vcHRpb25zLnZpZXdwb3J0TWFyZ2luKTtcbiAgICBpZiAoZGlzcGxheS5zaG93aW5nRnJvbSA8IGZyb20gJiYgZnJvbSAtIGRpc3BsYXkuc2hvd2luZ0Zyb20gPCAyMCkgZnJvbSA9IE1hdGgubWF4KGRvYy5maXJzdCwgZGlzcGxheS5zaG93aW5nRnJvbSk7XG4gICAgaWYgKGRpc3BsYXkuc2hvd2luZ1RvID4gdG8gJiYgZGlzcGxheS5zaG93aW5nVG8gLSB0byA8IDIwKSB0byA9IE1hdGgubWluKGVuZCwgZGlzcGxheS5zaG93aW5nVG8pO1xuICAgIGlmIChzYXdDb2xsYXBzZWRTcGFucykge1xuICAgICAgZnJvbSA9IGxpbmVObyh2aXN1YWxMaW5lKGRvYywgZ2V0TGluZShkb2MsIGZyb20pKSk7XG4gICAgICB3aGlsZSAodG8gPCBlbmQgJiYgbGluZUlzSGlkZGVuKGRvYywgZ2V0TGluZShkb2MsIHRvKSkpICsrdG87XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIGEgcmFuZ2Ugb2YgdGhlb3JldGljYWxseSBpbnRhY3QgbGluZXMsIGFuZCBwdW5jaCBob2xlc1xuICAgIC8vIGluIHRoYXQgdXNpbmcgdGhlIGNoYW5nZSBpbmZvLlxuICAgIHZhciBpbnRhY3QgPSBbe2Zyb206IE1hdGgubWF4KGRpc3BsYXkuc2hvd2luZ0Zyb20sIGRvYy5maXJzdCksXG4gICAgICAgICAgICAgICAgICAgdG86IE1hdGgubWluKGRpc3BsYXkuc2hvd2luZ1RvLCBlbmQpfV07XG4gICAgaWYgKGludGFjdFswXS5mcm9tID49IGludGFjdFswXS50bykgaW50YWN0ID0gW107XG4gICAgZWxzZSBpbnRhY3QgPSBjb21wdXRlSW50YWN0KGludGFjdCwgY2hhbmdlcyk7XG4gICAgLy8gV2hlbiBtZXJnZWQgbGluZXMgYXJlIHByZXNlbnQsIHdlIG1pZ2h0IGhhdmUgdG8gcmVkdWNlIHRoZVxuICAgIC8vIGludGFjdCByYW5nZXMgYmVjYXVzZSBjaGFuZ2VzIGluIGNvbnRpbnVlZCBmcmFnbWVudHMgb2YgdGhlXG4gICAgLy8gaW50YWN0IGxpbmVzIGRvIHJlcXVpcmUgdGhlIGxpbmVzIHRvIGJlIHJlZHJhd24uXG4gICAgaWYgKHNhd0NvbGxhcHNlZFNwYW5zKVxuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBpbnRhY3QubGVuZ3RoOyArK2kpIHtcbiAgICAgICAgdmFyIHJhbmdlID0gaW50YWN0W2ldLCBtZXJnZWQ7XG4gICAgICAgIHdoaWxlIChtZXJnZWQgPSBjb2xsYXBzZWRTcGFuQXRFbmQoZ2V0TGluZShkb2MsIHJhbmdlLnRvIC0gMSkpKSB7XG4gICAgICAgICAgdmFyIG5ld1RvID0gbWVyZ2VkLmZpbmQoKS5mcm9tLmxpbmU7XG4gICAgICAgICAgaWYgKG5ld1RvID4gcmFuZ2UuZnJvbSkgcmFuZ2UudG8gPSBuZXdUbztcbiAgICAgICAgICBlbHNlIHsgaW50YWN0LnNwbGljZShpLS0sIDEpOyBicmVhazsgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAvLyBDbGlwIG9mZiB0aGUgcGFydHMgdGhhdCB3b24ndCBiZSB2aXNpYmxlXG4gICAgdmFyIGludGFjdExpbmVzID0gMDtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGludGFjdC5sZW5ndGg7ICsraSkge1xuICAgICAgdmFyIHJhbmdlID0gaW50YWN0W2ldO1xuICAgICAgaWYgKHJhbmdlLmZyb20gPCBmcm9tKSByYW5nZS5mcm9tID0gZnJvbTtcbiAgICAgIGlmIChyYW5nZS50byA+IHRvKSByYW5nZS50byA9IHRvO1xuICAgICAgaWYgKHJhbmdlLmZyb20gPj0gcmFuZ2UudG8pIGludGFjdC5zcGxpY2UoaS0tLCAxKTtcbiAgICAgIGVsc2UgaW50YWN0TGluZXMgKz0gcmFuZ2UudG8gLSByYW5nZS5mcm9tO1xuICAgIH1cbiAgICBpZiAoIWZvcmNlZCAmJiBpbnRhY3RMaW5lcyA9PSB0byAtIGZyb20gJiYgZnJvbSA9PSBkaXNwbGF5LnNob3dpbmdGcm9tICYmIHRvID09IGRpc3BsYXkuc2hvd2luZ1RvKSB7XG4gICAgICB1cGRhdGVWaWV3T2Zmc2V0KGNtKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaW50YWN0LnNvcnQoZnVuY3Rpb24oYSwgYikge3JldHVybiBhLmZyb20gLSBiLmZyb207fSk7XG5cbiAgICAvLyBBdm9pZCBjcmFzaGluZyBvbiBJRSdzIFwidW5zcGVjaWZpZWQgZXJyb3JcIiB3aGVuIGluIGlmcmFtZXNcbiAgICB0cnkge1xuICAgICAgdmFyIGZvY3VzZWQgPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50O1xuICAgIH0gY2F0Y2goZSkge31cbiAgICBpZiAoaW50YWN0TGluZXMgPCAodG8gLSBmcm9tKSAqIC43KSBkaXNwbGF5LmxpbmVEaXYuc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICAgIHBhdGNoRGlzcGxheShjbSwgZnJvbSwgdG8sIGludGFjdCwgcG9zaXRpb25zQ2hhbmdlZEZyb20pO1xuICAgIGRpc3BsYXkubGluZURpdi5zdHlsZS5kaXNwbGF5ID0gXCJcIjtcbiAgICBpZiAoZm9jdXNlZCAmJiBkb2N1bWVudC5hY3RpdmVFbGVtZW50ICE9IGZvY3VzZWQgJiYgZm9jdXNlZC5vZmZzZXRIZWlnaHQpIGZvY3VzZWQuZm9jdXMoKTtcblxuICAgIHZhciBkaWZmZXJlbnQgPSBmcm9tICE9IGRpc3BsYXkuc2hvd2luZ0Zyb20gfHwgdG8gIT0gZGlzcGxheS5zaG93aW5nVG8gfHxcbiAgICAgIGRpc3BsYXkubGFzdFNpemVDICE9IGRpc3BsYXkud3JhcHBlci5jbGllbnRIZWlnaHQ7XG4gICAgLy8gVGhpcyBpcyBqdXN0IGEgYm9ndXMgZm9ybXVsYSB0aGF0IGRldGVjdHMgd2hlbiB0aGUgZWRpdG9yIGlzXG4gICAgLy8gcmVzaXplZCBvciB0aGUgZm9udCBzaXplIGNoYW5nZXMuXG4gICAgaWYgKGRpZmZlcmVudCkge1xuICAgICAgZGlzcGxheS5sYXN0U2l6ZUMgPSBkaXNwbGF5LndyYXBwZXIuY2xpZW50SGVpZ2h0O1xuICAgICAgc3RhcnRXb3JrZXIoY20sIDQwMCk7XG4gICAgfVxuICAgIGRpc3BsYXkuc2hvd2luZ0Zyb20gPSBmcm9tOyBkaXNwbGF5LnNob3dpbmdUbyA9IHRvO1xuXG4gICAgZGlzcGxheS5ndXR0ZXJzLnN0eWxlLmhlaWdodCA9IFwiXCI7XG4gICAgdXBkYXRlSGVpZ2h0c0luVmlld3BvcnQoY20pO1xuICAgIHVwZGF0ZVZpZXdPZmZzZXQoY20pO1xuXG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBmdW5jdGlvbiB1cGRhdGVIZWlnaHRzSW5WaWV3cG9ydChjbSkge1xuICAgIHZhciBkaXNwbGF5ID0gY20uZGlzcGxheTtcbiAgICB2YXIgcHJldkJvdHRvbSA9IGRpc3BsYXkubGluZURpdi5vZmZzZXRUb3A7XG4gICAgZm9yICh2YXIgbm9kZSA9IGRpc3BsYXkubGluZURpdi5maXJzdENoaWxkLCBoZWlnaHQ7IG5vZGU7IG5vZGUgPSBub2RlLm5leHRTaWJsaW5nKSBpZiAobm9kZS5saW5lT2JqKSB7XG4gICAgICBpZiAoaWVfbHQ4KSB7XG4gICAgICAgIHZhciBib3QgPSBub2RlLm9mZnNldFRvcCArIG5vZGUub2Zmc2V0SGVpZ2h0O1xuICAgICAgICBoZWlnaHQgPSBib3QgLSBwcmV2Qm90dG9tO1xuICAgICAgICBwcmV2Qm90dG9tID0gYm90O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIGJveCA9IGdldFJlY3Qobm9kZSk7XG4gICAgICAgIGhlaWdodCA9IGJveC5ib3R0b20gLSBib3gudG9wO1xuICAgICAgfVxuICAgICAgdmFyIGRpZmYgPSBub2RlLmxpbmVPYmouaGVpZ2h0IC0gaGVpZ2h0O1xuICAgICAgaWYgKGhlaWdodCA8IDIpIGhlaWdodCA9IHRleHRIZWlnaHQoZGlzcGxheSk7XG4gICAgICBpZiAoZGlmZiA+IC4wMDEgfHwgZGlmZiA8IC0uMDAxKSB7XG4gICAgICAgIHVwZGF0ZUxpbmVIZWlnaHQobm9kZS5saW5lT2JqLCBoZWlnaHQpO1xuICAgICAgICB2YXIgd2lkZ2V0cyA9IG5vZGUubGluZU9iai53aWRnZXRzO1xuICAgICAgICBpZiAod2lkZ2V0cykgZm9yICh2YXIgaSA9IDA7IGkgPCB3aWRnZXRzLmxlbmd0aDsgKytpKVxuICAgICAgICAgIHdpZGdldHNbaV0uaGVpZ2h0ID0gd2lkZ2V0c1tpXS5ub2RlLm9mZnNldEhlaWdodDtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiB1cGRhdGVWaWV3T2Zmc2V0KGNtKSB7XG4gICAgdmFyIG9mZiA9IGNtLmRpc3BsYXkudmlld09mZnNldCA9IGhlaWdodEF0TGluZShjbSwgZ2V0TGluZShjbS5kb2MsIGNtLmRpc3BsYXkuc2hvd2luZ0Zyb20pKTtcbiAgICAvLyBQb3NpdGlvbiB0aGUgbW92ZXIgZGl2IHRvIGFsaWduIHdpdGggdGhlIGN1cnJlbnQgdmlydHVhbCBzY3JvbGwgcG9zaXRpb25cbiAgICBjbS5kaXNwbGF5Lm1vdmVyLnN0eWxlLnRvcCA9IG9mZiArIFwicHhcIjtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNvbXB1dGVJbnRhY3QoaW50YWN0LCBjaGFuZ2VzKSB7XG4gICAgZm9yICh2YXIgaSA9IDAsIGwgPSBjaGFuZ2VzLmxlbmd0aCB8fCAwOyBpIDwgbDsgKytpKSB7XG4gICAgICB2YXIgY2hhbmdlID0gY2hhbmdlc1tpXSwgaW50YWN0MiA9IFtdLCBkaWZmID0gY2hhbmdlLmRpZmYgfHwgMDtcbiAgICAgIGZvciAodmFyIGogPSAwLCBsMiA9IGludGFjdC5sZW5ndGg7IGogPCBsMjsgKytqKSB7XG4gICAgICAgIHZhciByYW5nZSA9IGludGFjdFtqXTtcbiAgICAgICAgaWYgKGNoYW5nZS50byA8PSByYW5nZS5mcm9tICYmIGNoYW5nZS5kaWZmKSB7XG4gICAgICAgICAgaW50YWN0Mi5wdXNoKHtmcm9tOiByYW5nZS5mcm9tICsgZGlmZiwgdG86IHJhbmdlLnRvICsgZGlmZn0pO1xuICAgICAgICB9IGVsc2UgaWYgKGNoYW5nZS50byA8PSByYW5nZS5mcm9tIHx8IGNoYW5nZS5mcm9tID49IHJhbmdlLnRvKSB7XG4gICAgICAgICAgaW50YWN0Mi5wdXNoKHJhbmdlKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBpZiAoY2hhbmdlLmZyb20gPiByYW5nZS5mcm9tKVxuICAgICAgICAgICAgaW50YWN0Mi5wdXNoKHtmcm9tOiByYW5nZS5mcm9tLCB0bzogY2hhbmdlLmZyb219KTtcbiAgICAgICAgICBpZiAoY2hhbmdlLnRvIDwgcmFuZ2UudG8pXG4gICAgICAgICAgICBpbnRhY3QyLnB1c2goe2Zyb206IGNoYW5nZS50byArIGRpZmYsIHRvOiByYW5nZS50byArIGRpZmZ9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaW50YWN0ID0gaW50YWN0MjtcbiAgICB9XG4gICAgcmV0dXJuIGludGFjdDtcbiAgfVxuXG4gIGZ1bmN0aW9uIGdldERpbWVuc2lvbnMoY20pIHtcbiAgICB2YXIgZCA9IGNtLmRpc3BsYXksIGxlZnQgPSB7fSwgd2lkdGggPSB7fTtcbiAgICBmb3IgKHZhciBuID0gZC5ndXR0ZXJzLmZpcnN0Q2hpbGQsIGkgPSAwOyBuOyBuID0gbi5uZXh0U2libGluZywgKytpKSB7XG4gICAgICBsZWZ0W2NtLm9wdGlvbnMuZ3V0dGVyc1tpXV0gPSBuLm9mZnNldExlZnQ7XG4gICAgICB3aWR0aFtjbS5vcHRpb25zLmd1dHRlcnNbaV1dID0gbi5vZmZzZXRXaWR0aDtcbiAgICB9XG4gICAgcmV0dXJuIHtmaXhlZFBvczogY29tcGVuc2F0ZUZvckhTY3JvbGwoZCksXG4gICAgICAgICAgICBndXR0ZXJUb3RhbFdpZHRoOiBkLmd1dHRlcnMub2Zmc2V0V2lkdGgsXG4gICAgICAgICAgICBndXR0ZXJMZWZ0OiBsZWZ0LFxuICAgICAgICAgICAgZ3V0dGVyV2lkdGg6IHdpZHRoLFxuICAgICAgICAgICAgd3JhcHBlcldpZHRoOiBkLndyYXBwZXIuY2xpZW50V2lkdGh9O1xuICB9XG5cbiAgZnVuY3Rpb24gcGF0Y2hEaXNwbGF5KGNtLCBmcm9tLCB0bywgaW50YWN0LCB1cGRhdGVOdW1iZXJzRnJvbSkge1xuICAgIHZhciBkaW1zID0gZ2V0RGltZW5zaW9ucyhjbSk7XG4gICAgdmFyIGRpc3BsYXkgPSBjbS5kaXNwbGF5LCBsaW5lTnVtYmVycyA9IGNtLm9wdGlvbnMubGluZU51bWJlcnM7XG4gICAgaWYgKCFpbnRhY3QubGVuZ3RoICYmICghd2Via2l0IHx8ICFjbS5kaXNwbGF5LmN1cnJlbnRXaGVlbFRhcmdldCkpXG4gICAgICByZW1vdmVDaGlsZHJlbihkaXNwbGF5LmxpbmVEaXYpO1xuICAgIHZhciBjb250YWluZXIgPSBkaXNwbGF5LmxpbmVEaXYsIGN1ciA9IGNvbnRhaW5lci5maXJzdENoaWxkO1xuXG4gICAgZnVuY3Rpb24gcm0obm9kZSkge1xuICAgICAgdmFyIG5leHQgPSBub2RlLm5leHRTaWJsaW5nO1xuICAgICAgaWYgKHdlYmtpdCAmJiBtYWMgJiYgY20uZGlzcGxheS5jdXJyZW50V2hlZWxUYXJnZXQgPT0gbm9kZSkge1xuICAgICAgICBub2RlLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgICAgICAgbm9kZS5saW5lT2JqID0gbnVsbDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG5vZGUucGFyZW50Tm9kZS5yZW1vdmVDaGlsZChub2RlKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBuZXh0O1xuICAgIH1cblxuICAgIHZhciBuZXh0SW50YWN0ID0gaW50YWN0LnNoaWZ0KCksIGxpbmVOID0gZnJvbTtcbiAgICBjbS5kb2MuaXRlcihmcm9tLCB0bywgZnVuY3Rpb24obGluZSkge1xuICAgICAgaWYgKG5leHRJbnRhY3QgJiYgbmV4dEludGFjdC50byA9PSBsaW5lTikgbmV4dEludGFjdCA9IGludGFjdC5zaGlmdCgpO1xuICAgICAgaWYgKGxpbmVJc0hpZGRlbihjbS5kb2MsIGxpbmUpKSB7XG4gICAgICAgIGlmIChsaW5lLmhlaWdodCAhPSAwKSB1cGRhdGVMaW5lSGVpZ2h0KGxpbmUsIDApO1xuICAgICAgICBpZiAobGluZS53aWRnZXRzICYmIGN1ciAmJiBjdXIucHJldmlvdXNTaWJsaW5nKSBmb3IgKHZhciBpID0gMDsgaSA8IGxpbmUud2lkZ2V0cy5sZW5ndGg7ICsraSkge1xuICAgICAgICAgIHZhciB3ID0gbGluZS53aWRnZXRzW2ldO1xuICAgICAgICAgIGlmICh3LnNob3dJZkhpZGRlbikge1xuICAgICAgICAgICAgdmFyIHByZXYgPSBjdXIucHJldmlvdXNTaWJsaW5nO1xuICAgICAgICAgICAgaWYgKC9wcmUvaS50ZXN0KHByZXYubm9kZU5hbWUpKSB7XG4gICAgICAgICAgICAgIHZhciB3cmFwID0gZWx0KFwiZGl2XCIsIG51bGwsIG51bGwsIFwicG9zaXRpb246IHJlbGF0aXZlXCIpO1xuICAgICAgICAgICAgICBwcmV2LnBhcmVudE5vZGUucmVwbGFjZUNoaWxkKHdyYXAsIHByZXYpO1xuICAgICAgICAgICAgICB3cmFwLmFwcGVuZENoaWxkKHByZXYpO1xuICAgICAgICAgICAgICBwcmV2ID0gd3JhcDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHZhciB3bm9kZSA9IHByZXYuYXBwZW5kQ2hpbGQoZWx0KFwiZGl2XCIsIFt3Lm5vZGVdLCBcIkNvZGVNaXJyb3ItbGluZXdpZGdldFwiKSk7XG4gICAgICAgICAgICBpZiAoIXcuaGFuZGxlTW91c2VFdmVudHMpIHdub2RlLmlnbm9yZUV2ZW50cyA9IHRydWU7XG4gICAgICAgICAgICBwb3NpdGlvbkxpbmVXaWRnZXQodywgd25vZGUsIHByZXYsIGRpbXMpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChuZXh0SW50YWN0ICYmIG5leHRJbnRhY3QuZnJvbSA8PSBsaW5lTiAmJiBuZXh0SW50YWN0LnRvID4gbGluZU4pIHtcbiAgICAgICAgLy8gVGhpcyBsaW5lIGlzIGludGFjdC4gU2tpcCB0byB0aGUgYWN0dWFsIG5vZGUuIFVwZGF0ZSBpdHNcbiAgICAgICAgLy8gbGluZSBudW1iZXIgaWYgbmVlZGVkLlxuICAgICAgICB3aGlsZSAoY3VyLmxpbmVPYmogIT0gbGluZSkgY3VyID0gcm0oY3VyKTtcbiAgICAgICAgaWYgKGxpbmVOdW1iZXJzICYmIHVwZGF0ZU51bWJlcnNGcm9tIDw9IGxpbmVOICYmIGN1ci5saW5lTnVtYmVyKVxuICAgICAgICAgIHNldFRleHRDb250ZW50KGN1ci5saW5lTnVtYmVyLCBsaW5lTnVtYmVyRm9yKGNtLm9wdGlvbnMsIGxpbmVOKSk7XG4gICAgICAgIGN1ciA9IGN1ci5uZXh0U2libGluZztcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIEZvciBsaW5lcyB3aXRoIHdpZGdldHMsIG1ha2UgYW4gYXR0ZW1wdCB0byBmaW5kIGFuZCByZXVzZVxuICAgICAgICAvLyB0aGUgZXhpc3RpbmcgZWxlbWVudCwgc28gdGhhdCB3aWRnZXRzIGFyZW4ndCBuZWVkbGVzc2x5XG4gICAgICAgIC8vIHJlbW92ZWQgYW5kIHJlLWluc2VydGVkIGludG8gdGhlIGRvbVxuICAgICAgICBpZiAobGluZS53aWRnZXRzKSBmb3IgKHZhciBqID0gMCwgc2VhcmNoID0gY3VyLCByZXVzZTsgc2VhcmNoICYmIGogPCAyMDsgKytqLCBzZWFyY2ggPSBzZWFyY2gubmV4dFNpYmxpbmcpXG4gICAgICAgICAgaWYgKHNlYXJjaC5saW5lT2JqID09IGxpbmUgJiYgL2Rpdi9pLnRlc3Qoc2VhcmNoLm5vZGVOYW1lKSkgeyByZXVzZSA9IHNlYXJjaDsgYnJlYWs7IH1cbiAgICAgICAgLy8gVGhpcyBsaW5lIG5lZWRzIHRvIGJlIGdlbmVyYXRlZC5cbiAgICAgICAgdmFyIGxpbmVOb2RlID0gYnVpbGRMaW5lRWxlbWVudChjbSwgbGluZSwgbGluZU4sIGRpbXMsIHJldXNlKTtcbiAgICAgICAgaWYgKGxpbmVOb2RlICE9IHJldXNlKSB7XG4gICAgICAgICAgY29udGFpbmVyLmluc2VydEJlZm9yZShsaW5lTm9kZSwgY3VyKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB3aGlsZSAoY3VyICE9IHJldXNlKSBjdXIgPSBybShjdXIpO1xuICAgICAgICAgIGN1ciA9IGN1ci5uZXh0U2libGluZztcbiAgICAgICAgfVxuXG4gICAgICAgIGxpbmVOb2RlLmxpbmVPYmogPSBsaW5lO1xuICAgICAgfVxuICAgICAgKytsaW5lTjtcbiAgICB9KTtcbiAgICB3aGlsZSAoY3VyKSBjdXIgPSBybShjdXIpO1xuICB9XG5cbiAgZnVuY3Rpb24gYnVpbGRMaW5lRWxlbWVudChjbSwgbGluZSwgbGluZU5vLCBkaW1zLCByZXVzZSkge1xuICAgIHZhciBidWlsdCA9IGJ1aWxkTGluZUNvbnRlbnQoY20sIGxpbmUpLCBsaW5lRWxlbWVudCA9IGJ1aWx0LnByZTtcbiAgICB2YXIgbWFya2VycyA9IGxpbmUuZ3V0dGVyTWFya2VycywgZGlzcGxheSA9IGNtLmRpc3BsYXksIHdyYXA7XG5cbiAgICB2YXIgYmdDbGFzcyA9IGJ1aWx0LmJnQ2xhc3MgPyBidWlsdC5iZ0NsYXNzICsgXCIgXCIgKyAobGluZS5iZ0NsYXNzIHx8IFwiXCIpIDogbGluZS5iZ0NsYXNzO1xuICAgIGlmICghY20ub3B0aW9ucy5saW5lTnVtYmVycyAmJiAhbWFya2VycyAmJiAhYmdDbGFzcyAmJiAhbGluZS53cmFwQ2xhc3MgJiYgIWxpbmUud2lkZ2V0cylcbiAgICAgIHJldHVybiBsaW5lRWxlbWVudDtcblxuICAgIC8vIExpbmVzIHdpdGggZ3V0dGVyIGVsZW1lbnRzLCB3aWRnZXRzIG9yIGEgYmFja2dyb3VuZCBjbGFzcyBuZWVkXG4gICAgLy8gdG8gYmUgd3JhcHBlZCBhZ2FpbiwgYW5kIGhhdmUgdGhlIGV4dHJhIGVsZW1lbnRzIGFkZGVkIHRvIHRoZVxuICAgIC8vIHdyYXBwZXIgZGl2XG5cbiAgICBpZiAocmV1c2UpIHtcbiAgICAgIHJldXNlLmFsaWduYWJsZSA9IG51bGw7XG4gICAgICB2YXIgaXNPayA9IHRydWUsIHdpZGdldHNTZWVuID0gMCwgaW5zZXJ0QmVmb3JlID0gbnVsbDtcbiAgICAgIGZvciAodmFyIG4gPSByZXVzZS5maXJzdENoaWxkLCBuZXh0OyBuOyBuID0gbmV4dCkge1xuICAgICAgICBuZXh0ID0gbi5uZXh0U2libGluZztcbiAgICAgICAgaWYgKCEvXFxiQ29kZU1pcnJvci1saW5ld2lkZ2V0XFxiLy50ZXN0KG4uY2xhc3NOYW1lKSkge1xuICAgICAgICAgIHJldXNlLnJlbW92ZUNoaWxkKG4pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGluZS53aWRnZXRzLmxlbmd0aDsgKytpKSB7XG4gICAgICAgICAgICB2YXIgd2lkZ2V0ID0gbGluZS53aWRnZXRzW2ldO1xuICAgICAgICAgICAgaWYgKHdpZGdldC5ub2RlID09IG4uZmlyc3RDaGlsZCkge1xuICAgICAgICAgICAgICBpZiAoIXdpZGdldC5hYm92ZSAmJiAhaW5zZXJ0QmVmb3JlKSBpbnNlcnRCZWZvcmUgPSBuO1xuICAgICAgICAgICAgICBwb3NpdGlvbkxpbmVXaWRnZXQod2lkZ2V0LCBuLCByZXVzZSwgZGltcyk7XG4gICAgICAgICAgICAgICsrd2lkZ2V0c1NlZW47XG4gICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoaSA9PSBsaW5lLndpZGdldHMubGVuZ3RoKSB7IGlzT2sgPSBmYWxzZTsgYnJlYWs7IH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV1c2UuaW5zZXJ0QmVmb3JlKGxpbmVFbGVtZW50LCBpbnNlcnRCZWZvcmUpO1xuICAgICAgaWYgKGlzT2sgJiYgd2lkZ2V0c1NlZW4gPT0gbGluZS53aWRnZXRzLmxlbmd0aCkge1xuICAgICAgICB3cmFwID0gcmV1c2U7XG4gICAgICAgIHJldXNlLmNsYXNzTmFtZSA9IGxpbmUud3JhcENsYXNzIHx8IFwiXCI7XG4gICAgICB9XG4gICAgfVxuICAgIGlmICghd3JhcCkge1xuICAgICAgd3JhcCA9IGVsdChcImRpdlwiLCBudWxsLCBsaW5lLndyYXBDbGFzcywgXCJwb3NpdGlvbjogcmVsYXRpdmVcIik7XG4gICAgICB3cmFwLmFwcGVuZENoaWxkKGxpbmVFbGVtZW50KTtcbiAgICB9XG4gICAgLy8gS2x1ZGdlIHRvIG1ha2Ugc3VyZSB0aGUgc3R5bGVkIGVsZW1lbnQgbGllcyBiZWhpbmQgdGhlIHNlbGVjdGlvbiAoYnkgei1pbmRleClcbiAgICBpZiAoYmdDbGFzcylcbiAgICAgIHdyYXAuaW5zZXJ0QmVmb3JlKGVsdChcImRpdlwiLCBudWxsLCBiZ0NsYXNzICsgXCIgQ29kZU1pcnJvci1saW5lYmFja2dyb3VuZFwiKSwgd3JhcC5maXJzdENoaWxkKTtcbiAgICBpZiAoY20ub3B0aW9ucy5saW5lTnVtYmVycyB8fCBtYXJrZXJzKSB7XG4gICAgICB2YXIgZ3V0dGVyV3JhcCA9IHdyYXAuaW5zZXJ0QmVmb3JlKGVsdChcImRpdlwiLCBudWxsLCBcIkNvZGVNaXJyb3ItZ3V0dGVyLXdyYXBwZXJcIiwgXCJwb3NpdGlvbjogYWJzb2x1dGU7IGxlZnQ6IFwiICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIChjbS5vcHRpb25zLmZpeGVkR3V0dGVyID8gZGltcy5maXhlZFBvcyA6IC1kaW1zLmd1dHRlclRvdGFsV2lkdGgpICsgXCJweFwiKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGluZUVsZW1lbnQpO1xuICAgICAgaWYgKGNtLm9wdGlvbnMuZml4ZWRHdXR0ZXIpICh3cmFwLmFsaWduYWJsZSB8fCAod3JhcC5hbGlnbmFibGUgPSBbXSkpLnB1c2goZ3V0dGVyV3JhcCk7XG4gICAgICBpZiAoY20ub3B0aW9ucy5saW5lTnVtYmVycyAmJiAoIW1hcmtlcnMgfHwgIW1hcmtlcnNbXCJDb2RlTWlycm9yLWxpbmVudW1iZXJzXCJdKSlcbiAgICAgICAgd3JhcC5saW5lTnVtYmVyID0gZ3V0dGVyV3JhcC5hcHBlbmRDaGlsZChcbiAgICAgICAgICBlbHQoXCJkaXZcIiwgbGluZU51bWJlckZvcihjbS5vcHRpb25zLCBsaW5lTm8pLFxuICAgICAgICAgICAgICBcIkNvZGVNaXJyb3ItbGluZW51bWJlciBDb2RlTWlycm9yLWd1dHRlci1lbHRcIixcbiAgICAgICAgICAgICAgXCJsZWZ0OiBcIiArIGRpbXMuZ3V0dGVyTGVmdFtcIkNvZGVNaXJyb3ItbGluZW51bWJlcnNcIl0gKyBcInB4OyB3aWR0aDogXCJcbiAgICAgICAgICAgICAgKyBkaXNwbGF5LmxpbmVOdW1Jbm5lcldpZHRoICsgXCJweFwiKSk7XG4gICAgICBpZiAobWFya2VycylcbiAgICAgICAgZm9yICh2YXIgayA9IDA7IGsgPCBjbS5vcHRpb25zLmd1dHRlcnMubGVuZ3RoOyArK2spIHtcbiAgICAgICAgICB2YXIgaWQgPSBjbS5vcHRpb25zLmd1dHRlcnNba10sIGZvdW5kID0gbWFya2Vycy5oYXNPd25Qcm9wZXJ0eShpZCkgJiYgbWFya2Vyc1tpZF07XG4gICAgICAgICAgaWYgKGZvdW5kKVxuICAgICAgICAgICAgZ3V0dGVyV3JhcC5hcHBlbmRDaGlsZChlbHQoXCJkaXZcIiwgW2ZvdW5kXSwgXCJDb2RlTWlycm9yLWd1dHRlci1lbHRcIiwgXCJsZWZ0OiBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkaW1zLmd1dHRlckxlZnRbaWRdICsgXCJweDsgd2lkdGg6IFwiICsgZGltcy5ndXR0ZXJXaWR0aFtpZF0gKyBcInB4XCIpKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBpZiAoaWVfbHQ4KSB3cmFwLnN0eWxlLnpJbmRleCA9IDI7XG4gICAgaWYgKGxpbmUud2lkZ2V0cyAmJiB3cmFwICE9IHJldXNlKSBmb3IgKHZhciBpID0gMCwgd3MgPSBsaW5lLndpZGdldHM7IGkgPCB3cy5sZW5ndGg7ICsraSkge1xuICAgICAgdmFyIHdpZGdldCA9IHdzW2ldLCBub2RlID0gZWx0KFwiZGl2XCIsIFt3aWRnZXQubm9kZV0sIFwiQ29kZU1pcnJvci1saW5ld2lkZ2V0XCIpO1xuICAgICAgaWYgKCF3aWRnZXQuaGFuZGxlTW91c2VFdmVudHMpIG5vZGUuaWdub3JlRXZlbnRzID0gdHJ1ZTtcbiAgICAgIHBvc2l0aW9uTGluZVdpZGdldCh3aWRnZXQsIG5vZGUsIHdyYXAsIGRpbXMpO1xuICAgICAgaWYgKHdpZGdldC5hYm92ZSlcbiAgICAgICAgd3JhcC5pbnNlcnRCZWZvcmUobm9kZSwgY20ub3B0aW9ucy5saW5lTnVtYmVycyAmJiBsaW5lLmhlaWdodCAhPSAwID8gZ3V0dGVyV3JhcCA6IGxpbmVFbGVtZW50KTtcbiAgICAgIGVsc2VcbiAgICAgICAgd3JhcC5hcHBlbmRDaGlsZChub2RlKTtcbiAgICAgIHNpZ25hbExhdGVyKHdpZGdldCwgXCJyZWRyYXdcIik7XG4gICAgfVxuICAgIHJldHVybiB3cmFwO1xuICB9XG5cbiAgZnVuY3Rpb24gcG9zaXRpb25MaW5lV2lkZ2V0KHdpZGdldCwgbm9kZSwgd3JhcCwgZGltcykge1xuICAgIGlmICh3aWRnZXQubm9IU2Nyb2xsKSB7XG4gICAgICAod3JhcC5hbGlnbmFibGUgfHwgKHdyYXAuYWxpZ25hYmxlID0gW10pKS5wdXNoKG5vZGUpO1xuICAgICAgdmFyIHdpZHRoID0gZGltcy53cmFwcGVyV2lkdGg7XG4gICAgICBub2RlLnN0eWxlLmxlZnQgPSBkaW1zLmZpeGVkUG9zICsgXCJweFwiO1xuICAgICAgaWYgKCF3aWRnZXQuY292ZXJHdXR0ZXIpIHtcbiAgICAgICAgd2lkdGggLT0gZGltcy5ndXR0ZXJUb3RhbFdpZHRoO1xuICAgICAgICBub2RlLnN0eWxlLnBhZGRpbmdMZWZ0ID0gZGltcy5ndXR0ZXJUb3RhbFdpZHRoICsgXCJweFwiO1xuICAgICAgfVxuICAgICAgbm9kZS5zdHlsZS53aWR0aCA9IHdpZHRoICsgXCJweFwiO1xuICAgIH1cbiAgICBpZiAod2lkZ2V0LmNvdmVyR3V0dGVyKSB7XG4gICAgICBub2RlLnN0eWxlLnpJbmRleCA9IDU7XG4gICAgICBub2RlLnN0eWxlLnBvc2l0aW9uID0gXCJyZWxhdGl2ZVwiO1xuICAgICAgaWYgKCF3aWRnZXQubm9IU2Nyb2xsKSBub2RlLnN0eWxlLm1hcmdpbkxlZnQgPSAtZGltcy5ndXR0ZXJUb3RhbFdpZHRoICsgXCJweFwiO1xuICAgIH1cbiAgfVxuXG4gIC8vIFNFTEVDVElPTiAvIENVUlNPUlxuXG4gIGZ1bmN0aW9uIHVwZGF0ZVNlbGVjdGlvbihjbSkge1xuICAgIHZhciBkaXNwbGF5ID0gY20uZGlzcGxheTtcbiAgICB2YXIgY29sbGFwc2VkID0gcG9zRXEoY20uZG9jLnNlbC5mcm9tLCBjbS5kb2Muc2VsLnRvKTtcbiAgICBpZiAoY29sbGFwc2VkIHx8IGNtLm9wdGlvbnMuc2hvd0N1cnNvcldoZW5TZWxlY3RpbmcpXG4gICAgICB1cGRhdGVTZWxlY3Rpb25DdXJzb3IoY20pO1xuICAgIGVsc2VcbiAgICAgIGRpc3BsYXkuY3Vyc29yLnN0eWxlLmRpc3BsYXkgPSBkaXNwbGF5Lm90aGVyQ3Vyc29yLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgICBpZiAoIWNvbGxhcHNlZClcbiAgICAgIHVwZGF0ZVNlbGVjdGlvblJhbmdlKGNtKTtcbiAgICBlbHNlXG4gICAgICBkaXNwbGF5LnNlbGVjdGlvbkRpdi5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG5cbiAgICAvLyBNb3ZlIHRoZSBoaWRkZW4gdGV4dGFyZWEgbmVhciB0aGUgY3Vyc29yIHRvIHByZXZlbnQgc2Nyb2xsaW5nIGFydGlmYWN0c1xuICAgIGlmIChjbS5vcHRpb25zLm1vdmVJbnB1dFdpdGhDdXJzb3IpIHtcbiAgICAgIHZhciBoZWFkUG9zID0gY3Vyc29yQ29vcmRzKGNtLCBjbS5kb2Muc2VsLmhlYWQsIFwiZGl2XCIpO1xuICAgICAgdmFyIHdyYXBPZmYgPSBnZXRSZWN0KGRpc3BsYXkud3JhcHBlciksIGxpbmVPZmYgPSBnZXRSZWN0KGRpc3BsYXkubGluZURpdik7XG4gICAgICBkaXNwbGF5LmlucHV0RGl2LnN0eWxlLnRvcCA9IE1hdGgubWF4KDAsIE1hdGgubWluKGRpc3BsYXkud3JhcHBlci5jbGllbnRIZWlnaHQgLSAxMCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaGVhZFBvcy50b3AgKyBsaW5lT2ZmLnRvcCAtIHdyYXBPZmYudG9wKSkgKyBcInB4XCI7XG4gICAgICBkaXNwbGF5LmlucHV0RGl2LnN0eWxlLmxlZnQgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihkaXNwbGF5LndyYXBwZXIuY2xpZW50V2lkdGggLSAxMCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGhlYWRQb3MubGVmdCArIGxpbmVPZmYubGVmdCAtIHdyYXBPZmYubGVmdCkpICsgXCJweFwiO1xuICAgIH1cbiAgfVxuXG4gIC8vIE5vIHNlbGVjdGlvbiwgcGxhaW4gY3Vyc29yXG4gIGZ1bmN0aW9uIHVwZGF0ZVNlbGVjdGlvbkN1cnNvcihjbSkge1xuICAgIHZhciBkaXNwbGF5ID0gY20uZGlzcGxheSwgcG9zID0gY3Vyc29yQ29vcmRzKGNtLCBjbS5kb2Muc2VsLmhlYWQsIFwiZGl2XCIpO1xuICAgIGRpc3BsYXkuY3Vyc29yLnN0eWxlLmxlZnQgPSBwb3MubGVmdCArIFwicHhcIjtcbiAgICBkaXNwbGF5LmN1cnNvci5zdHlsZS50b3AgPSBwb3MudG9wICsgXCJweFwiO1xuICAgIGRpc3BsYXkuY3Vyc29yLnN0eWxlLmhlaWdodCA9IE1hdGgubWF4KDAsIHBvcy5ib3R0b20gLSBwb3MudG9wKSAqIGNtLm9wdGlvbnMuY3Vyc29ySGVpZ2h0ICsgXCJweFwiO1xuICAgIGRpc3BsYXkuY3Vyc29yLnN0eWxlLmRpc3BsYXkgPSBcIlwiO1xuXG4gICAgaWYgKHBvcy5vdGhlcikge1xuICAgICAgZGlzcGxheS5vdGhlckN1cnNvci5zdHlsZS5kaXNwbGF5ID0gXCJcIjtcbiAgICAgIGRpc3BsYXkub3RoZXJDdXJzb3Iuc3R5bGUubGVmdCA9IHBvcy5vdGhlci5sZWZ0ICsgXCJweFwiO1xuICAgICAgZGlzcGxheS5vdGhlckN1cnNvci5zdHlsZS50b3AgPSBwb3Mub3RoZXIudG9wICsgXCJweFwiO1xuICAgICAgZGlzcGxheS5vdGhlckN1cnNvci5zdHlsZS5oZWlnaHQgPSAocG9zLm90aGVyLmJvdHRvbSAtIHBvcy5vdGhlci50b3ApICogLjg1ICsgXCJweFwiO1xuICAgIH0gZWxzZSB7IGRpc3BsYXkub3RoZXJDdXJzb3Iuc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiOyB9XG4gIH1cblxuICAvLyBIaWdobGlnaHQgc2VsZWN0aW9uXG4gIGZ1bmN0aW9uIHVwZGF0ZVNlbGVjdGlvblJhbmdlKGNtKSB7XG4gICAgdmFyIGRpc3BsYXkgPSBjbS5kaXNwbGF5LCBkb2MgPSBjbS5kb2MsIHNlbCA9IGNtLmRvYy5zZWw7XG4gICAgdmFyIGZyYWdtZW50ID0gZG9jdW1lbnQuY3JlYXRlRG9jdW1lbnRGcmFnbWVudCgpO1xuICAgIHZhciBwYWRkaW5nID0gcGFkZGluZ0goY20uZGlzcGxheSksIGxlZnRTaWRlID0gcGFkZGluZy5sZWZ0LCByaWdodFNpZGUgPSBkaXNwbGF5LmxpbmVTcGFjZS5vZmZzZXRXaWR0aCAtIHBhZGRpbmcucmlnaHQ7XG5cbiAgICBmdW5jdGlvbiBhZGQobGVmdCwgdG9wLCB3aWR0aCwgYm90dG9tKSB7XG4gICAgICBpZiAodG9wIDwgMCkgdG9wID0gMDtcbiAgICAgIGZyYWdtZW50LmFwcGVuZENoaWxkKGVsdChcImRpdlwiLCBudWxsLCBcIkNvZGVNaXJyb3Itc2VsZWN0ZWRcIiwgXCJwb3NpdGlvbjogYWJzb2x1dGU7IGxlZnQ6IFwiICsgbGVmdCArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJweDsgdG9wOiBcIiArIHRvcCArIFwicHg7IHdpZHRoOiBcIiArICh3aWR0aCA9PSBudWxsID8gcmlnaHRTaWRlIC0gbGVmdCA6IHdpZHRoKSArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJweDsgaGVpZ2h0OiBcIiArIChib3R0b20gLSB0b3ApICsgXCJweFwiKSk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZHJhd0ZvckxpbmUobGluZSwgZnJvbUFyZywgdG9BcmcpIHtcbiAgICAgIHZhciBsaW5lT2JqID0gZ2V0TGluZShkb2MsIGxpbmUpO1xuICAgICAgdmFyIGxpbmVMZW4gPSBsaW5lT2JqLnRleHQubGVuZ3RoO1xuICAgICAgdmFyIHN0YXJ0LCBlbmQ7XG4gICAgICBmdW5jdGlvbiBjb29yZHMoY2gsIGJpYXMpIHtcbiAgICAgICAgcmV0dXJuIGNoYXJDb29yZHMoY20sIFBvcyhsaW5lLCBjaCksIFwiZGl2XCIsIGxpbmVPYmosIGJpYXMpO1xuICAgICAgfVxuXG4gICAgICBpdGVyYXRlQmlkaVNlY3Rpb25zKGdldE9yZGVyKGxpbmVPYmopLCBmcm9tQXJnIHx8IDAsIHRvQXJnID09IG51bGwgPyBsaW5lTGVuIDogdG9BcmcsIGZ1bmN0aW9uKGZyb20sIHRvLCBkaXIpIHtcbiAgICAgICAgdmFyIGxlZnRQb3MgPSBjb29yZHMoZnJvbSwgXCJsZWZ0XCIpLCByaWdodFBvcywgbGVmdCwgcmlnaHQ7XG4gICAgICAgIGlmIChmcm9tID09IHRvKSB7XG4gICAgICAgICAgcmlnaHRQb3MgPSBsZWZ0UG9zO1xuICAgICAgICAgIGxlZnQgPSByaWdodCA9IGxlZnRQb3MubGVmdDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByaWdodFBvcyA9IGNvb3Jkcyh0byAtIDEsIFwicmlnaHRcIik7XG4gICAgICAgICAgaWYgKGRpciA9PSBcInJ0bFwiKSB7IHZhciB0bXAgPSBsZWZ0UG9zOyBsZWZ0UG9zID0gcmlnaHRQb3M7IHJpZ2h0UG9zID0gdG1wOyB9XG4gICAgICAgICAgbGVmdCA9IGxlZnRQb3MubGVmdDtcbiAgICAgICAgICByaWdodCA9IHJpZ2h0UG9zLnJpZ2h0O1xuICAgICAgICB9XG4gICAgICAgIGlmIChmcm9tQXJnID09IG51bGwgJiYgZnJvbSA9PSAwKSBsZWZ0ID0gbGVmdFNpZGU7XG4gICAgICAgIGlmIChyaWdodFBvcy50b3AgLSBsZWZ0UG9zLnRvcCA+IDMpIHsgLy8gRGlmZmVyZW50IGxpbmVzLCBkcmF3IHRvcCBwYXJ0XG4gICAgICAgICAgYWRkKGxlZnQsIGxlZnRQb3MudG9wLCBudWxsLCBsZWZ0UG9zLmJvdHRvbSk7XG4gICAgICAgICAgbGVmdCA9IGxlZnRTaWRlO1xuICAgICAgICAgIGlmIChsZWZ0UG9zLmJvdHRvbSA8IHJpZ2h0UG9zLnRvcCkgYWRkKGxlZnQsIGxlZnRQb3MuYm90dG9tLCBudWxsLCByaWdodFBvcy50b3ApO1xuICAgICAgICB9XG4gICAgICAgIGlmICh0b0FyZyA9PSBudWxsICYmIHRvID09IGxpbmVMZW4pIHJpZ2h0ID0gcmlnaHRTaWRlO1xuICAgICAgICBpZiAoIXN0YXJ0IHx8IGxlZnRQb3MudG9wIDwgc3RhcnQudG9wIHx8IGxlZnRQb3MudG9wID09IHN0YXJ0LnRvcCAmJiBsZWZ0UG9zLmxlZnQgPCBzdGFydC5sZWZ0KVxuICAgICAgICAgIHN0YXJ0ID0gbGVmdFBvcztcbiAgICAgICAgaWYgKCFlbmQgfHwgcmlnaHRQb3MuYm90dG9tID4gZW5kLmJvdHRvbSB8fCByaWdodFBvcy5ib3R0b20gPT0gZW5kLmJvdHRvbSAmJiByaWdodFBvcy5yaWdodCA+IGVuZC5yaWdodClcbiAgICAgICAgICBlbmQgPSByaWdodFBvcztcbiAgICAgICAgaWYgKGxlZnQgPCBsZWZ0U2lkZSArIDEpIGxlZnQgPSBsZWZ0U2lkZTtcbiAgICAgICAgYWRkKGxlZnQsIHJpZ2h0UG9zLnRvcCwgcmlnaHQgLSBsZWZ0LCByaWdodFBvcy5ib3R0b20pO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4ge3N0YXJ0OiBzdGFydCwgZW5kOiBlbmR9O1xuICAgIH1cblxuICAgIGlmIChzZWwuZnJvbS5saW5lID09IHNlbC50by5saW5lKSB7XG4gICAgICBkcmF3Rm9yTGluZShzZWwuZnJvbS5saW5lLCBzZWwuZnJvbS5jaCwgc2VsLnRvLmNoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdmFyIGZyb21MaW5lID0gZ2V0TGluZShkb2MsIHNlbC5mcm9tLmxpbmUpLCB0b0xpbmUgPSBnZXRMaW5lKGRvYywgc2VsLnRvLmxpbmUpO1xuICAgICAgdmFyIHNpbmdsZVZMaW5lID0gdmlzdWFsTGluZShkb2MsIGZyb21MaW5lKSA9PSB2aXN1YWxMaW5lKGRvYywgdG9MaW5lKTtcbiAgICAgIHZhciBsZWZ0RW5kID0gZHJhd0ZvckxpbmUoc2VsLmZyb20ubGluZSwgc2VsLmZyb20uY2gsIHNpbmdsZVZMaW5lID8gZnJvbUxpbmUudGV4dC5sZW5ndGggOiBudWxsKS5lbmQ7XG4gICAgICB2YXIgcmlnaHRTdGFydCA9IGRyYXdGb3JMaW5lKHNlbC50by5saW5lLCBzaW5nbGVWTGluZSA/IDAgOiBudWxsLCBzZWwudG8uY2gpLnN0YXJ0O1xuICAgICAgaWYgKHNpbmdsZVZMaW5lKSB7XG4gICAgICAgIGlmIChsZWZ0RW5kLnRvcCA8IHJpZ2h0U3RhcnQudG9wIC0gMikge1xuICAgICAgICAgIGFkZChsZWZ0RW5kLnJpZ2h0LCBsZWZ0RW5kLnRvcCwgbnVsbCwgbGVmdEVuZC5ib3R0b20pO1xuICAgICAgICAgIGFkZChsZWZ0U2lkZSwgcmlnaHRTdGFydC50b3AsIHJpZ2h0U3RhcnQubGVmdCwgcmlnaHRTdGFydC5ib3R0b20pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGFkZChsZWZ0RW5kLnJpZ2h0LCBsZWZ0RW5kLnRvcCwgcmlnaHRTdGFydC5sZWZ0IC0gbGVmdEVuZC5yaWdodCwgbGVmdEVuZC5ib3R0b20pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAobGVmdEVuZC5ib3R0b20gPCByaWdodFN0YXJ0LnRvcClcbiAgICAgICAgYWRkKGxlZnRTaWRlLCBsZWZ0RW5kLmJvdHRvbSwgbnVsbCwgcmlnaHRTdGFydC50b3ApO1xuICAgIH1cblxuICAgIHJlbW92ZUNoaWxkcmVuQW5kQWRkKGRpc3BsYXkuc2VsZWN0aW9uRGl2LCBmcmFnbWVudCk7XG4gICAgZGlzcGxheS5zZWxlY3Rpb25EaXYuc3R5bGUuZGlzcGxheSA9IFwiXCI7XG4gIH1cblxuICAvLyBDdXJzb3ItYmxpbmtpbmdcbiAgZnVuY3Rpb24gcmVzdGFydEJsaW5rKGNtKSB7XG4gICAgaWYgKCFjbS5zdGF0ZS5mb2N1c2VkKSByZXR1cm47XG4gICAgdmFyIGRpc3BsYXkgPSBjbS5kaXNwbGF5O1xuICAgIGNsZWFySW50ZXJ2YWwoZGlzcGxheS5ibGlua2VyKTtcbiAgICB2YXIgb24gPSB0cnVlO1xuICAgIGRpc3BsYXkuY3Vyc29yLnN0eWxlLnZpc2liaWxpdHkgPSBkaXNwbGF5Lm90aGVyQ3Vyc29yLnN0eWxlLnZpc2liaWxpdHkgPSBcIlwiO1xuICAgIGlmIChjbS5vcHRpb25zLmN1cnNvckJsaW5rUmF0ZSA+IDApXG4gICAgICBkaXNwbGF5LmJsaW5rZXIgPSBzZXRJbnRlcnZhbChmdW5jdGlvbigpIHtcbiAgICAgICAgZGlzcGxheS5jdXJzb3Iuc3R5bGUudmlzaWJpbGl0eSA9IGRpc3BsYXkub3RoZXJDdXJzb3Iuc3R5bGUudmlzaWJpbGl0eSA9IChvbiA9ICFvbikgPyBcIlwiIDogXCJoaWRkZW5cIjtcbiAgICAgIH0sIGNtLm9wdGlvbnMuY3Vyc29yQmxpbmtSYXRlKTtcbiAgfVxuXG4gIC8vIEhJR0hMSUdIVCBXT1JLRVJcblxuICBmdW5jdGlvbiBzdGFydFdvcmtlcihjbSwgdGltZSkge1xuICAgIGlmIChjbS5kb2MubW9kZS5zdGFydFN0YXRlICYmIGNtLmRvYy5mcm9udGllciA8IGNtLmRpc3BsYXkuc2hvd2luZ1RvKVxuICAgICAgY20uc3RhdGUuaGlnaGxpZ2h0LnNldCh0aW1lLCBiaW5kKGhpZ2hsaWdodFdvcmtlciwgY20pKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhpZ2hsaWdodFdvcmtlcihjbSkge1xuICAgIHZhciBkb2MgPSBjbS5kb2M7XG4gICAgaWYgKGRvYy5mcm9udGllciA8IGRvYy5maXJzdCkgZG9jLmZyb250aWVyID0gZG9jLmZpcnN0O1xuICAgIGlmIChkb2MuZnJvbnRpZXIgPj0gY20uZGlzcGxheS5zaG93aW5nVG8pIHJldHVybjtcbiAgICB2YXIgZW5kID0gK25ldyBEYXRlICsgY20ub3B0aW9ucy53b3JrVGltZTtcbiAgICB2YXIgc3RhdGUgPSBjb3B5U3RhdGUoZG9jLm1vZGUsIGdldFN0YXRlQmVmb3JlKGNtLCBkb2MuZnJvbnRpZXIpKTtcbiAgICB2YXIgY2hhbmdlZCA9IFtdLCBwcmV2Q2hhbmdlO1xuICAgIGRvYy5pdGVyKGRvYy5mcm9udGllciwgTWF0aC5taW4oZG9jLmZpcnN0ICsgZG9jLnNpemUsIGNtLmRpc3BsYXkuc2hvd2luZ1RvICsgNTAwKSwgZnVuY3Rpb24obGluZSkge1xuICAgICAgaWYgKGRvYy5mcm9udGllciA+PSBjbS5kaXNwbGF5LnNob3dpbmdGcm9tKSB7IC8vIFZpc2libGVcbiAgICAgICAgdmFyIG9sZFN0eWxlcyA9IGxpbmUuc3R5bGVzO1xuICAgICAgICBsaW5lLnN0eWxlcyA9IGhpZ2hsaWdodExpbmUoY20sIGxpbmUsIHN0YXRlLCB0cnVlKTtcbiAgICAgICAgdmFyIGlzY2hhbmdlID0gIW9sZFN0eWxlcyB8fCBvbGRTdHlsZXMubGVuZ3RoICE9IGxpbmUuc3R5bGVzLmxlbmd0aDtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7ICFpc2NoYW5nZSAmJiBpIDwgb2xkU3R5bGVzLmxlbmd0aDsgKytpKSBpc2NoYW5nZSA9IG9sZFN0eWxlc1tpXSAhPSBsaW5lLnN0eWxlc1tpXTtcbiAgICAgICAgaWYgKGlzY2hhbmdlKSB7XG4gICAgICAgICAgaWYgKHByZXZDaGFuZ2UgJiYgcHJldkNoYW5nZS5lbmQgPT0gZG9jLmZyb250aWVyKSBwcmV2Q2hhbmdlLmVuZCsrO1xuICAgICAgICAgIGVsc2UgY2hhbmdlZC5wdXNoKHByZXZDaGFuZ2UgPSB7c3RhcnQ6IGRvYy5mcm9udGllciwgZW5kOiBkb2MuZnJvbnRpZXIgKyAxfSk7XG4gICAgICAgIH1cbiAgICAgICAgbGluZS5zdGF0ZUFmdGVyID0gY29weVN0YXRlKGRvYy5tb2RlLCBzdGF0ZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwcm9jZXNzTGluZShjbSwgbGluZS50ZXh0LCBzdGF0ZSk7XG4gICAgICAgIGxpbmUuc3RhdGVBZnRlciA9IGRvYy5mcm9udGllciAlIDUgPT0gMCA/IGNvcHlTdGF0ZShkb2MubW9kZSwgc3RhdGUpIDogbnVsbDtcbiAgICAgIH1cbiAgICAgICsrZG9jLmZyb250aWVyO1xuICAgICAgaWYgKCtuZXcgRGF0ZSA+IGVuZCkge1xuICAgICAgICBzdGFydFdvcmtlcihjbSwgY20ub3B0aW9ucy53b3JrRGVsYXkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBpZiAoY2hhbmdlZC5sZW5ndGgpXG4gICAgICBvcGVyYXRpb24oY20sIGZ1bmN0aW9uKCkge1xuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGNoYW5nZWQubGVuZ3RoOyArK2kpXG4gICAgICAgICAgcmVnQ2hhbmdlKHRoaXMsIGNoYW5nZWRbaV0uc3RhcnQsIGNoYW5nZWRbaV0uZW5kKTtcbiAgICAgIH0pKCk7XG4gIH1cblxuICAvLyBGaW5kcyB0aGUgbGluZSB0byBzdGFydCB3aXRoIHdoZW4gc3RhcnRpbmcgYSBwYXJzZS4gVHJpZXMgdG9cbiAgLy8gZmluZCBhIGxpbmUgd2l0aCBhIHN0YXRlQWZ0ZXIsIHNvIHRoYXQgaXQgY2FuIHN0YXJ0IHdpdGggYVxuICAvLyB2YWxpZCBzdGF0ZS4gSWYgdGhhdCBmYWlscywgaXQgcmV0dXJucyB0aGUgbGluZSB3aXRoIHRoZVxuICAvLyBzbWFsbGVzdCBpbmRlbnRhdGlvbiwgd2hpY2ggdGVuZHMgdG8gbmVlZCB0aGUgbGVhc3QgY29udGV4dCB0b1xuICAvLyBwYXJzZSBjb3JyZWN0bHkuXG4gIGZ1bmN0aW9uIGZpbmRTdGFydExpbmUoY20sIG4sIHByZWNpc2UpIHtcbiAgICB2YXIgbWluaW5kZW50LCBtaW5saW5lLCBkb2MgPSBjbS5kb2M7XG4gICAgdmFyIGxpbSA9IHByZWNpc2UgPyAtMSA6IG4gLSAoY20uZG9jLm1vZGUuaW5uZXJNb2RlID8gMTAwMCA6IDEwMCk7XG4gICAgZm9yICh2YXIgc2VhcmNoID0gbjsgc2VhcmNoID4gbGltOyAtLXNlYXJjaCkge1xuICAgICAgaWYgKHNlYXJjaCA8PSBkb2MuZmlyc3QpIHJldHVybiBkb2MuZmlyc3Q7XG4gICAgICB2YXIgbGluZSA9IGdldExpbmUoZG9jLCBzZWFyY2ggLSAxKTtcbiAgICAgIGlmIChsaW5lLnN0YXRlQWZ0ZXIgJiYgKCFwcmVjaXNlIHx8IHNlYXJjaCA8PSBkb2MuZnJvbnRpZXIpKSByZXR1cm4gc2VhcmNoO1xuICAgICAgdmFyIGluZGVudGVkID0gY291bnRDb2x1bW4obGluZS50ZXh0LCBudWxsLCBjbS5vcHRpb25zLnRhYlNpemUpO1xuICAgICAgaWYgKG1pbmxpbmUgPT0gbnVsbCB8fCBtaW5pbmRlbnQgPiBpbmRlbnRlZCkge1xuICAgICAgICBtaW5saW5lID0gc2VhcmNoIC0gMTtcbiAgICAgICAgbWluaW5kZW50ID0gaW5kZW50ZWQ7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBtaW5saW5lO1xuICB9XG5cbiAgZnVuY3Rpb24gZ2V0U3RhdGVCZWZvcmUoY20sIG4sIHByZWNpc2UpIHtcbiAgICB2YXIgZG9jID0gY20uZG9jLCBkaXNwbGF5ID0gY20uZGlzcGxheTtcbiAgICBpZiAoIWRvYy5tb2RlLnN0YXJ0U3RhdGUpIHJldHVybiB0cnVlO1xuICAgIHZhciBwb3MgPSBmaW5kU3RhcnRMaW5lKGNtLCBuLCBwcmVjaXNlKSwgc3RhdGUgPSBwb3MgPiBkb2MuZmlyc3QgJiYgZ2V0TGluZShkb2MsIHBvcy0xKS5zdGF0ZUFmdGVyO1xuICAgIGlmICghc3RhdGUpIHN0YXRlID0gc3RhcnRTdGF0ZShkb2MubW9kZSk7XG4gICAgZWxzZSBzdGF0ZSA9IGNvcHlTdGF0ZShkb2MubW9kZSwgc3RhdGUpO1xuICAgIGRvYy5pdGVyKHBvcywgbiwgZnVuY3Rpb24obGluZSkge1xuICAgICAgcHJvY2Vzc0xpbmUoY20sIGxpbmUudGV4dCwgc3RhdGUpO1xuICAgICAgdmFyIHNhdmUgPSBwb3MgPT0gbiAtIDEgfHwgcG9zICUgNSA9PSAwIHx8IHBvcyA+PSBkaXNwbGF5LnNob3dpbmdGcm9tICYmIHBvcyA8IGRpc3BsYXkuc2hvd2luZ1RvO1xuICAgICAgbGluZS5zdGF0ZUFmdGVyID0gc2F2ZSA/IGNvcHlTdGF0ZShkb2MubW9kZSwgc3RhdGUpIDogbnVsbDtcbiAgICAgICsrcG9zO1xuICAgIH0pO1xuICAgIGlmIChwcmVjaXNlKSBkb2MuZnJvbnRpZXIgPSBwb3M7XG4gICAgcmV0dXJuIHN0YXRlO1xuICB9XG5cbiAgLy8gUE9TSVRJT04gTUVBU1VSRU1FTlRcblxuICBmdW5jdGlvbiBwYWRkaW5nVG9wKGRpc3BsYXkpIHtyZXR1cm4gZGlzcGxheS5saW5lU3BhY2Uub2Zmc2V0VG9wO31cbiAgZnVuY3Rpb24gcGFkZGluZ1ZlcnQoZGlzcGxheSkge3JldHVybiBkaXNwbGF5Lm1vdmVyLm9mZnNldEhlaWdodCAtIGRpc3BsYXkubGluZVNwYWNlLm9mZnNldEhlaWdodDt9XG4gIGZ1bmN0aW9uIHBhZGRpbmdIKGRpc3BsYXkpIHtcbiAgICBpZiAoZGlzcGxheS5jYWNoZWRQYWRkaW5nSCkgcmV0dXJuIGRpc3BsYXkuY2FjaGVkUGFkZGluZ0g7XG4gICAgdmFyIGUgPSByZW1vdmVDaGlsZHJlbkFuZEFkZChkaXNwbGF5Lm1lYXN1cmUsIGVsdChcInByZVwiLCBcInhcIikpO1xuICAgIHZhciBzdHlsZSA9IHdpbmRvdy5nZXRDb21wdXRlZFN0eWxlID8gd2luZG93LmdldENvbXB1dGVkU3R5bGUoZSkgOiBlLmN1cnJlbnRTdHlsZTtcbiAgICByZXR1cm4gZGlzcGxheS5jYWNoZWRQYWRkaW5nSCA9IHtsZWZ0OiBwYXJzZUludChzdHlsZS5wYWRkaW5nTGVmdCksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmlnaHQ6IHBhcnNlSW50KHN0eWxlLnBhZGRpbmdSaWdodCl9O1xuICB9XG5cbiAgZnVuY3Rpb24gbWVhc3VyZUNoYXIoY20sIGxpbmUsIGNoLCBkYXRhLCBiaWFzKSB7XG4gICAgdmFyIGRpciA9IC0xO1xuICAgIGRhdGEgPSBkYXRhIHx8IG1lYXN1cmVMaW5lKGNtLCBsaW5lKTtcbiAgICBpZiAoZGF0YS5jcnVkZSkge1xuICAgICAgdmFyIGxlZnQgPSBkYXRhLmxlZnQgKyBjaCAqIGRhdGEud2lkdGg7XG4gICAgICByZXR1cm4ge2xlZnQ6IGxlZnQsIHJpZ2h0OiBsZWZ0ICsgZGF0YS53aWR0aCwgdG9wOiBkYXRhLnRvcCwgYm90dG9tOiBkYXRhLmJvdHRvbX07XG4gICAgfVxuXG4gICAgZm9yICh2YXIgcG9zID0gY2g7OyBwb3MgKz0gZGlyKSB7XG4gICAgICB2YXIgciA9IGRhdGFbcG9zXTtcbiAgICAgIGlmIChyKSBicmVhaztcbiAgICAgIGlmIChkaXIgPCAwICYmIHBvcyA9PSAwKSBkaXIgPSAxO1xuICAgIH1cbiAgICBiaWFzID0gcG9zID4gY2ggPyBcImxlZnRcIiA6IHBvcyA8IGNoID8gXCJyaWdodFwiIDogYmlhcztcbiAgICBpZiAoYmlhcyA9PSBcImxlZnRcIiAmJiByLmxlZnRTaWRlKSByID0gci5sZWZ0U2lkZTtcbiAgICBlbHNlIGlmIChiaWFzID09IFwicmlnaHRcIiAmJiByLnJpZ2h0U2lkZSkgciA9IHIucmlnaHRTaWRlO1xuICAgIHJldHVybiB7bGVmdDogcG9zIDwgY2ggPyByLnJpZ2h0IDogci5sZWZ0LFxuICAgICAgICAgICAgcmlnaHQ6IHBvcyA+IGNoID8gci5sZWZ0IDogci5yaWdodCxcbiAgICAgICAgICAgIHRvcDogci50b3AsXG4gICAgICAgICAgICBib3R0b206IHIuYm90dG9tfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGZpbmRDYWNoZWRNZWFzdXJlbWVudChjbSwgbGluZSkge1xuICAgIHZhciBjYWNoZSA9IGNtLmRpc3BsYXkubWVhc3VyZUxpbmVDYWNoZTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGNhY2hlLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YXIgbWVtbyA9IGNhY2hlW2ldO1xuICAgICAgaWYgKG1lbW8udGV4dCA9PSBsaW5lLnRleHQgJiYgbWVtby5tYXJrZWRTcGFucyA9PSBsaW5lLm1hcmtlZFNwYW5zICYmXG4gICAgICAgICAgY20uZGlzcGxheS5zY3JvbGxlci5jbGllbnRXaWR0aCA9PSBtZW1vLndpZHRoICYmXG4gICAgICAgICAgbWVtby5jbGFzc2VzID09IGxpbmUudGV4dENsYXNzICsgXCJ8XCIgKyBsaW5lLndyYXBDbGFzcylcbiAgICAgICAgcmV0dXJuIG1lbW87XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gY2xlYXJDYWNoZWRNZWFzdXJlbWVudChjbSwgbGluZSkge1xuICAgIHZhciBleGlzdHMgPSBmaW5kQ2FjaGVkTWVhc3VyZW1lbnQoY20sIGxpbmUpO1xuICAgIGlmIChleGlzdHMpIGV4aXN0cy50ZXh0ID0gZXhpc3RzLm1lYXN1cmUgPSBleGlzdHMubWFya2VkU3BhbnMgPSBudWxsO1xuICB9XG5cbiAgZnVuY3Rpb24gbWVhc3VyZUxpbmUoY20sIGxpbmUpIHtcbiAgICAvLyBGaXJzdCBsb29rIGluIHRoZSBjYWNoZVxuICAgIHZhciBjYWNoZWQgPSBmaW5kQ2FjaGVkTWVhc3VyZW1lbnQoY20sIGxpbmUpO1xuICAgIGlmIChjYWNoZWQpIHJldHVybiBjYWNoZWQubWVhc3VyZTtcblxuICAgIC8vIEZhaWxpbmcgdGhhdCwgcmVjb21wdXRlIGFuZCBzdG9yZSByZXN1bHQgaW4gY2FjaGVcbiAgICB2YXIgbWVhc3VyZSA9IG1lYXN1cmVMaW5lSW5uZXIoY20sIGxpbmUpO1xuICAgIHZhciBjYWNoZSA9IGNtLmRpc3BsYXkubWVhc3VyZUxpbmVDYWNoZTtcbiAgICB2YXIgbWVtbyA9IHt0ZXh0OiBsaW5lLnRleHQsIHdpZHRoOiBjbS5kaXNwbGF5LnNjcm9sbGVyLmNsaWVudFdpZHRoLFxuICAgICAgICAgICAgICAgIG1hcmtlZFNwYW5zOiBsaW5lLm1hcmtlZFNwYW5zLCBtZWFzdXJlOiBtZWFzdXJlLFxuICAgICAgICAgICAgICAgIGNsYXNzZXM6IGxpbmUudGV4dENsYXNzICsgXCJ8XCIgKyBsaW5lLndyYXBDbGFzc307XG4gICAgaWYgKGNhY2hlLmxlbmd0aCA9PSAxNikgY2FjaGVbKytjbS5kaXNwbGF5Lm1lYXN1cmVMaW5lQ2FjaGVQb3MgJSAxNl0gPSBtZW1vO1xuICAgIGVsc2UgY2FjaGUucHVzaChtZW1vKTtcbiAgICByZXR1cm4gbWVhc3VyZTtcbiAgfVxuXG4gIGZ1bmN0aW9uIG1lYXN1cmVMaW5lSW5uZXIoY20sIGxpbmUpIHtcbiAgICBpZiAoIWNtLm9wdGlvbnMubGluZVdyYXBwaW5nICYmIGxpbmUudGV4dC5sZW5ndGggPj0gY20ub3B0aW9ucy5jcnVkZU1lYXN1cmluZ0Zyb20pXG4gICAgICByZXR1cm4gY3J1ZGVseU1lYXN1cmVMaW5lKGNtLCBsaW5lKTtcblxuICAgIHZhciBkaXNwbGF5ID0gY20uZGlzcGxheSwgbWVhc3VyZSA9IGVtcHR5QXJyYXkobGluZS50ZXh0Lmxlbmd0aCk7XG4gICAgdmFyIHByZSA9IGJ1aWxkTGluZUNvbnRlbnQoY20sIGxpbmUsIG1lYXN1cmUsIHRydWUpLnByZTtcblxuICAgIC8vIElFIGRvZXMgbm90IGNhY2hlIGVsZW1lbnQgcG9zaXRpb25zIG9mIGlubGluZSBlbGVtZW50cyBiZXR3ZWVuXG4gICAgLy8gY2FsbHMgdG8gZ2V0Qm91bmRpbmdDbGllbnRSZWN0LiBUaGlzIG1ha2VzIHRoZSBsb29wIGJlbG93LFxuICAgIC8vIHdoaWNoIGdhdGhlcnMgdGhlIHBvc2l0aW9ucyBvZiBhbGwgdGhlIGNoYXJhY3RlcnMgb24gdGhlIGxpbmUsXG4gICAgLy8gZG8gYW4gYW1vdW50IG9mIGxheW91dCB3b3JrIHF1YWRyYXRpYyB0byB0aGUgbnVtYmVyIG9mXG4gICAgLy8gY2hhcmFjdGVycy4gV2hlbiBsaW5lIHdyYXBwaW5nIGlzIG9mZiwgd2UgdHJ5IHRvIGltcHJvdmUgdGhpbmdzXG4gICAgLy8gYnkgZmlyc3Qgc3ViZGl2aWRpbmcgdGhlIGxpbmUgaW50byBhIGJ1bmNoIG9mIGlubGluZSBibG9ja3MsIHNvXG4gICAgLy8gdGhhdCBJRSBjYW4gcmV1c2UgbW9zdCBvZiB0aGUgbGF5b3V0IGluZm9ybWF0aW9uIGZyb20gY2FjaGVzXG4gICAgLy8gZm9yIHRob3NlIGJsb2Nrcy4gVGhpcyBkb2VzIGludGVyZmVyZSB3aXRoIGxpbmUgd3JhcHBpbmcsIHNvIGl0XG4gICAgLy8gZG9lc24ndCB3b3JrIHdoZW4gd3JhcHBpbmcgaXMgb24sIGJ1dCBpbiB0aGF0IGNhc2UgdGhlXG4gICAgLy8gc2l0dWF0aW9uIGlzIHNsaWdodGx5IGJldHRlciwgc2luY2UgSUUgZG9lcyBjYWNoZSBsaW5lLXdyYXBwaW5nXG4gICAgLy8gaW5mb3JtYXRpb24gYW5kIG9ubHkgcmVjb21wdXRlcyBwZXItbGluZS5cbiAgICBpZiAob2xkX2llICYmICFpZV9sdDggJiYgIWNtLm9wdGlvbnMubGluZVdyYXBwaW5nICYmIHByZS5jaGlsZE5vZGVzLmxlbmd0aCA+IDEwMCkge1xuICAgICAgdmFyIGZyYWdtZW50ID0gZG9jdW1lbnQuY3JlYXRlRG9jdW1lbnRGcmFnbWVudCgpO1xuICAgICAgdmFyIGNodW5rID0gMTAsIG4gPSBwcmUuY2hpbGROb2Rlcy5sZW5ndGg7XG4gICAgICBmb3IgKHZhciBpID0gMCwgY2h1bmtzID0gTWF0aC5jZWlsKG4gLyBjaHVuayk7IGkgPCBjaHVua3M7ICsraSkge1xuICAgICAgICB2YXIgd3JhcCA9IGVsdChcImRpdlwiLCBudWxsLCBudWxsLCBcImRpc3BsYXk6IGlubGluZS1ibG9ja1wiKTtcbiAgICAgICAgZm9yICh2YXIgaiA9IDA7IGogPCBjaHVuayAmJiBuOyArK2opIHtcbiAgICAgICAgICB3cmFwLmFwcGVuZENoaWxkKHByZS5maXJzdENoaWxkKTtcbiAgICAgICAgICAtLW47XG4gICAgICAgIH1cbiAgICAgICAgZnJhZ21lbnQuYXBwZW5kQ2hpbGQod3JhcCk7XG4gICAgICB9XG4gICAgICBwcmUuYXBwZW5kQ2hpbGQoZnJhZ21lbnQpO1xuICAgIH1cblxuICAgIHJlbW92ZUNoaWxkcmVuQW5kQWRkKGRpc3BsYXkubWVhc3VyZSwgcHJlKTtcblxuICAgIHZhciBvdXRlciA9IGdldFJlY3QoZGlzcGxheS5saW5lRGl2KTtcbiAgICB2YXIgdnJhbmdlcyA9IFtdLCBkYXRhID0gZW1wdHlBcnJheShsaW5lLnRleHQubGVuZ3RoKSwgbWF4Qm90ID0gcHJlLm9mZnNldEhlaWdodDtcbiAgICAvLyBXb3JrIGFyb3VuZCBhbiBJRTcvOCBidWcgd2hlcmUgaXQgd2lsbCBzb21ldGltZXMgaGF2ZSByYW5kb21seVxuICAgIC8vIHJlcGxhY2VkIG91ciBwcmUgd2l0aCBhIGNsb25lIGF0IHRoaXMgcG9pbnQuXG4gICAgaWYgKGllX2x0OSAmJiBkaXNwbGF5Lm1lYXN1cmUuZmlyc3QgIT0gcHJlKVxuICAgICAgcmVtb3ZlQ2hpbGRyZW5BbmRBZGQoZGlzcGxheS5tZWFzdXJlLCBwcmUpO1xuXG4gICAgZnVuY3Rpb24gbWVhc3VyZVJlY3QocmVjdCkge1xuICAgICAgdmFyIHRvcCA9IHJlY3QudG9wIC0gb3V0ZXIudG9wLCBib3QgPSByZWN0LmJvdHRvbSAtIG91dGVyLnRvcDtcbiAgICAgIGlmIChib3QgPiBtYXhCb3QpIGJvdCA9IG1heEJvdDtcbiAgICAgIGlmICh0b3AgPCAwKSB0b3AgPSAwO1xuICAgICAgZm9yICh2YXIgaSA9IHZyYW5nZXMubGVuZ3RoIC0gMjsgaSA+PSAwOyBpIC09IDIpIHtcbiAgICAgICAgdmFyIHJ0b3AgPSB2cmFuZ2VzW2ldLCByYm90ID0gdnJhbmdlc1tpKzFdO1xuICAgICAgICBpZiAocnRvcCA+IGJvdCB8fCByYm90IDwgdG9wKSBjb250aW51ZTtcbiAgICAgICAgaWYgKHJ0b3AgPD0gdG9wICYmIHJib3QgPj0gYm90IHx8XG4gICAgICAgICAgICB0b3AgPD0gcnRvcCAmJiBib3QgPj0gcmJvdCB8fFxuICAgICAgICAgICAgTWF0aC5taW4oYm90LCByYm90KSAtIE1hdGgubWF4KHRvcCwgcnRvcCkgPj0gKGJvdCAtIHRvcCkgPj4gMSkge1xuICAgICAgICAgIHZyYW5nZXNbaV0gPSBNYXRoLm1pbih0b3AsIHJ0b3ApO1xuICAgICAgICAgIHZyYW5nZXNbaSsxXSA9IE1hdGgubWF4KGJvdCwgcmJvdCk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChpIDwgMCkgeyBpID0gdnJhbmdlcy5sZW5ndGg7IHZyYW5nZXMucHVzaCh0b3AsIGJvdCk7IH1cbiAgICAgIHJldHVybiB7bGVmdDogcmVjdC5sZWZ0IC0gb3V0ZXIubGVmdCxcbiAgICAgICAgICAgICAgcmlnaHQ6IHJlY3QucmlnaHQgLSBvdXRlci5sZWZ0LFxuICAgICAgICAgICAgICB0b3A6IGksIGJvdHRvbTogbnVsbH07XG4gICAgfVxuICAgIGZ1bmN0aW9uIGZpbmlzaFJlY3QocmVjdCkge1xuICAgICAgcmVjdC5ib3R0b20gPSB2cmFuZ2VzW3JlY3QudG9wKzFdO1xuICAgICAgcmVjdC50b3AgPSB2cmFuZ2VzW3JlY3QudG9wXTtcbiAgICB9XG5cbiAgICBmb3IgKHZhciBpID0gMCwgY3VyOyBpIDwgbWVhc3VyZS5sZW5ndGg7ICsraSkgaWYgKGN1ciA9IG1lYXN1cmVbaV0pIHtcbiAgICAgIHZhciBub2RlID0gY3VyLCByZWN0ID0gbnVsbDtcbiAgICAgIC8vIEEgd2lkZ2V0IG1pZ2h0IHdyYXAsIG5lZWRzIHNwZWNpYWwgY2FyZVxuICAgICAgaWYgKC9cXGJDb2RlTWlycm9yLXdpZGdldFxcYi8udGVzdChjdXIuY2xhc3NOYW1lKSAmJiBjdXIuZ2V0Q2xpZW50UmVjdHMpIHtcbiAgICAgICAgaWYgKGN1ci5maXJzdENoaWxkLm5vZGVUeXBlID09IDEpIG5vZGUgPSBjdXIuZmlyc3RDaGlsZDtcbiAgICAgICAgdmFyIHJlY3RzID0gbm9kZS5nZXRDbGllbnRSZWN0cygpO1xuICAgICAgICBpZiAocmVjdHMubGVuZ3RoID4gMSkge1xuICAgICAgICAgIHJlY3QgPSBkYXRhW2ldID0gbWVhc3VyZVJlY3QocmVjdHNbMF0pO1xuICAgICAgICAgIHJlY3QucmlnaHRTaWRlID0gbWVhc3VyZVJlY3QocmVjdHNbcmVjdHMubGVuZ3RoIC0gMV0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoIXJlY3QpIHJlY3QgPSBkYXRhW2ldID0gbWVhc3VyZVJlY3QoZ2V0UmVjdChub2RlKSk7XG4gICAgICBpZiAoY3VyLm1lYXN1cmVSaWdodCkgcmVjdC5yaWdodCA9IGdldFJlY3QoY3VyLm1lYXN1cmVSaWdodCkubGVmdCAtIG91dGVyLmxlZnQ7XG4gICAgICBpZiAoY3VyLmxlZnRTaWRlKSByZWN0LmxlZnRTaWRlID0gbWVhc3VyZVJlY3QoZ2V0UmVjdChjdXIubGVmdFNpZGUpKTtcbiAgICB9XG4gICAgcmVtb3ZlQ2hpbGRyZW4oY20uZGlzcGxheS5tZWFzdXJlKTtcbiAgICBmb3IgKHZhciBpID0gMCwgY3VyOyBpIDwgZGF0YS5sZW5ndGg7ICsraSkgaWYgKGN1ciA9IGRhdGFbaV0pIHtcbiAgICAgIGZpbmlzaFJlY3QoY3VyKTtcbiAgICAgIGlmIChjdXIubGVmdFNpZGUpIGZpbmlzaFJlY3QoY3VyLmxlZnRTaWRlKTtcbiAgICAgIGlmIChjdXIucmlnaHRTaWRlKSBmaW5pc2hSZWN0KGN1ci5yaWdodFNpZGUpO1xuICAgIH1cbiAgICByZXR1cm4gZGF0YTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNydWRlbHlNZWFzdXJlTGluZShjbSwgbGluZSkge1xuICAgIHZhciBjb3B5ID0gbmV3IExpbmUobGluZS50ZXh0LnNsaWNlKDAsIDEwMCksIG51bGwpO1xuICAgIGlmIChsaW5lLnRleHRDbGFzcykgY29weS50ZXh0Q2xhc3MgPSBsaW5lLnRleHRDbGFzcztcbiAgICB2YXIgbWVhc3VyZSA9IG1lYXN1cmVMaW5lSW5uZXIoY20sIGNvcHkpO1xuICAgIHZhciBsZWZ0ID0gbWVhc3VyZUNoYXIoY20sIGNvcHksIDAsIG1lYXN1cmUsIFwibGVmdFwiKTtcbiAgICB2YXIgcmlnaHQgPSBtZWFzdXJlQ2hhcihjbSwgY29weSwgOTksIG1lYXN1cmUsIFwicmlnaHRcIik7XG4gICAgcmV0dXJuIHtjcnVkZTogdHJ1ZSwgdG9wOiBsZWZ0LnRvcCwgbGVmdDogbGVmdC5sZWZ0LCBib3R0b206IGxlZnQuYm90dG9tLCB3aWR0aDogKHJpZ2h0LnJpZ2h0IC0gbGVmdC5sZWZ0KSAvIDEwMH07XG4gIH1cblxuICBmdW5jdGlvbiBtZWFzdXJlTGluZVdpZHRoKGNtLCBsaW5lKSB7XG4gICAgdmFyIGhhc0JhZFNwYW4gPSBmYWxzZTtcbiAgICBpZiAobGluZS5tYXJrZWRTcGFucykgZm9yICh2YXIgaSA9IDA7IGkgPCBsaW5lLm1hcmtlZFNwYW5zOyArK2kpIHtcbiAgICAgIHZhciBzcCA9IGxpbmUubWFya2VkU3BhbnNbaV07XG4gICAgICBpZiAoc3AuY29sbGFwc2VkICYmIChzcC50byA9PSBudWxsIHx8IHNwLnRvID09IGxpbmUudGV4dC5sZW5ndGgpKSBoYXNCYWRTcGFuID0gdHJ1ZTtcbiAgICB9XG4gICAgdmFyIGNhY2hlZCA9ICFoYXNCYWRTcGFuICYmIGZpbmRDYWNoZWRNZWFzdXJlbWVudChjbSwgbGluZSk7XG4gICAgaWYgKGNhY2hlZCB8fCBsaW5lLnRleHQubGVuZ3RoID49IGNtLm9wdGlvbnMuY3J1ZGVNZWFzdXJpbmdGcm9tKVxuICAgICAgcmV0dXJuIG1lYXN1cmVDaGFyKGNtLCBsaW5lLCBsaW5lLnRleHQubGVuZ3RoLCBjYWNoZWQgJiYgY2FjaGVkLm1lYXN1cmUsIFwicmlnaHRcIikucmlnaHQ7XG5cbiAgICB2YXIgcHJlID0gYnVpbGRMaW5lQ29udGVudChjbSwgbGluZSwgbnVsbCwgdHJ1ZSkucHJlO1xuICAgIHZhciBlbmQgPSBwcmUuYXBwZW5kQ2hpbGQoemVyb1dpZHRoRWxlbWVudChjbS5kaXNwbGF5Lm1lYXN1cmUpKTtcbiAgICByZW1vdmVDaGlsZHJlbkFuZEFkZChjbS5kaXNwbGF5Lm1lYXN1cmUsIHByZSk7XG4gICAgcmV0dXJuIGdldFJlY3QoZW5kKS5yaWdodCAtIGdldFJlY3QoY20uZGlzcGxheS5saW5lRGl2KS5sZWZ0O1xuICB9XG5cbiAgZnVuY3Rpb24gY2xlYXJDYWNoZXMoY20pIHtcbiAgICBjbS5kaXNwbGF5Lm1lYXN1cmVMaW5lQ2FjaGUubGVuZ3RoID0gY20uZGlzcGxheS5tZWFzdXJlTGluZUNhY2hlUG9zID0gMDtcbiAgICBjbS5kaXNwbGF5LmNhY2hlZENoYXJXaWR0aCA9IGNtLmRpc3BsYXkuY2FjaGVkVGV4dEhlaWdodCA9IGNtLmRpc3BsYXkuY2FjaGVkUGFkZGluZ0ggPSBudWxsO1xuICAgIGlmICghY20ub3B0aW9ucy5saW5lV3JhcHBpbmcpIGNtLmRpc3BsYXkubWF4TGluZUNoYW5nZWQgPSB0cnVlO1xuICAgIGNtLmRpc3BsYXkubGluZU51bUNoYXJzID0gbnVsbDtcbiAgfVxuXG4gIGZ1bmN0aW9uIHBhZ2VTY3JvbGxYKCkgeyByZXR1cm4gd2luZG93LnBhZ2VYT2Zmc2V0IHx8IChkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQgfHwgZG9jdW1lbnQuYm9keSkuc2Nyb2xsTGVmdDsgfVxuICBmdW5jdGlvbiBwYWdlU2Nyb2xsWSgpIHsgcmV0dXJuIHdpbmRvdy5wYWdlWU9mZnNldCB8fCAoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50IHx8IGRvY3VtZW50LmJvZHkpLnNjcm9sbFRvcDsgfVxuXG4gIC8vIENvbnRleHQgaXMgb25lIG9mIFwibGluZVwiLCBcImRpdlwiIChkaXNwbGF5LmxpbmVEaXYpLCBcImxvY2FsXCIvbnVsbCAoZWRpdG9yKSwgb3IgXCJwYWdlXCJcbiAgZnVuY3Rpb24gaW50b0Nvb3JkU3lzdGVtKGNtLCBsaW5lT2JqLCByZWN0LCBjb250ZXh0KSB7XG4gICAgaWYgKGxpbmVPYmoud2lkZ2V0cykgZm9yICh2YXIgaSA9IDA7IGkgPCBsaW5lT2JqLndpZGdldHMubGVuZ3RoOyArK2kpIGlmIChsaW5lT2JqLndpZGdldHNbaV0uYWJvdmUpIHtcbiAgICAgIHZhciBzaXplID0gd2lkZ2V0SGVpZ2h0KGxpbmVPYmoud2lkZ2V0c1tpXSk7XG4gICAgICByZWN0LnRvcCArPSBzaXplOyByZWN0LmJvdHRvbSArPSBzaXplO1xuICAgIH1cbiAgICBpZiAoY29udGV4dCA9PSBcImxpbmVcIikgcmV0dXJuIHJlY3Q7XG4gICAgaWYgKCFjb250ZXh0KSBjb250ZXh0ID0gXCJsb2NhbFwiO1xuICAgIHZhciB5T2ZmID0gaGVpZ2h0QXRMaW5lKGNtLCBsaW5lT2JqKTtcbiAgICBpZiAoY29udGV4dCA9PSBcImxvY2FsXCIpIHlPZmYgKz0gcGFkZGluZ1RvcChjbS5kaXNwbGF5KTtcbiAgICBlbHNlIHlPZmYgLT0gY20uZGlzcGxheS52aWV3T2Zmc2V0O1xuICAgIGlmIChjb250ZXh0ID09IFwicGFnZVwiIHx8IGNvbnRleHQgPT0gXCJ3aW5kb3dcIikge1xuICAgICAgdmFyIGxPZmYgPSBnZXRSZWN0KGNtLmRpc3BsYXkubGluZVNwYWNlKTtcbiAgICAgIHlPZmYgKz0gbE9mZi50b3AgKyAoY29udGV4dCA9PSBcIndpbmRvd1wiID8gMCA6IHBhZ2VTY3JvbGxZKCkpO1xuICAgICAgdmFyIHhPZmYgPSBsT2ZmLmxlZnQgKyAoY29udGV4dCA9PSBcIndpbmRvd1wiID8gMCA6IHBhZ2VTY3JvbGxYKCkpO1xuICAgICAgcmVjdC5sZWZ0ICs9IHhPZmY7IHJlY3QucmlnaHQgKz0geE9mZjtcbiAgICB9XG4gICAgcmVjdC50b3AgKz0geU9mZjsgcmVjdC5ib3R0b20gKz0geU9mZjtcbiAgICByZXR1cm4gcmVjdDtcbiAgfVxuXG4gIC8vIENvbnRleHQgbWF5IGJlIFwid2luZG93XCIsIFwicGFnZVwiLCBcImRpdlwiLCBvciBcImxvY2FsXCIvbnVsbFxuICAvLyBSZXN1bHQgaXMgaW4gXCJkaXZcIiBjb29yZHNcbiAgZnVuY3Rpb24gZnJvbUNvb3JkU3lzdGVtKGNtLCBjb29yZHMsIGNvbnRleHQpIHtcbiAgICBpZiAoY29udGV4dCA9PSBcImRpdlwiKSByZXR1cm4gY29vcmRzO1xuICAgIHZhciBsZWZ0ID0gY29vcmRzLmxlZnQsIHRvcCA9IGNvb3Jkcy50b3A7XG4gICAgLy8gRmlyc3QgbW92ZSBpbnRvIFwicGFnZVwiIGNvb3JkaW5hdGUgc3lzdGVtXG4gICAgaWYgKGNvbnRleHQgPT0gXCJwYWdlXCIpIHtcbiAgICAgIGxlZnQgLT0gcGFnZVNjcm9sbFgoKTtcbiAgICAgIHRvcCAtPSBwYWdlU2Nyb2xsWSgpO1xuICAgIH0gZWxzZSBpZiAoY29udGV4dCA9PSBcImxvY2FsXCIgfHwgIWNvbnRleHQpIHtcbiAgICAgIHZhciBsb2NhbEJveCA9IGdldFJlY3QoY20uZGlzcGxheS5zaXplcik7XG4gICAgICBsZWZ0ICs9IGxvY2FsQm94LmxlZnQ7XG4gICAgICB0b3AgKz0gbG9jYWxCb3gudG9wO1xuICAgIH1cblxuICAgIHZhciBsaW5lU3BhY2VCb3ggPSBnZXRSZWN0KGNtLmRpc3BsYXkubGluZVNwYWNlKTtcbiAgICByZXR1cm4ge2xlZnQ6IGxlZnQgLSBsaW5lU3BhY2VCb3gubGVmdCwgdG9wOiB0b3AgLSBsaW5lU3BhY2VCb3gudG9wfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNoYXJDb29yZHMoY20sIHBvcywgY29udGV4dCwgbGluZU9iaiwgYmlhcykge1xuICAgIGlmICghbGluZU9iaikgbGluZU9iaiA9IGdldExpbmUoY20uZG9jLCBwb3MubGluZSk7XG4gICAgcmV0dXJuIGludG9Db29yZFN5c3RlbShjbSwgbGluZU9iaiwgbWVhc3VyZUNoYXIoY20sIGxpbmVPYmosIHBvcy5jaCwgbnVsbCwgYmlhcyksIGNvbnRleHQpO1xuICB9XG5cbiAgZnVuY3Rpb24gY3Vyc29yQ29vcmRzKGNtLCBwb3MsIGNvbnRleHQsIGxpbmVPYmosIG1lYXN1cmVtZW50KSB7XG4gICAgbGluZU9iaiA9IGxpbmVPYmogfHwgZ2V0TGluZShjbS5kb2MsIHBvcy5saW5lKTtcbiAgICBpZiAoIW1lYXN1cmVtZW50KSBtZWFzdXJlbWVudCA9IG1lYXN1cmVMaW5lKGNtLCBsaW5lT2JqKTtcbiAgICBmdW5jdGlvbiBnZXQoY2gsIHJpZ2h0KSB7XG4gICAgICB2YXIgbSA9IG1lYXN1cmVDaGFyKGNtLCBsaW5lT2JqLCBjaCwgbWVhc3VyZW1lbnQsIHJpZ2h0ID8gXCJyaWdodFwiIDogXCJsZWZ0XCIpO1xuICAgICAgaWYgKHJpZ2h0KSBtLmxlZnQgPSBtLnJpZ2h0OyBlbHNlIG0ucmlnaHQgPSBtLmxlZnQ7XG4gICAgICByZXR1cm4gaW50b0Nvb3JkU3lzdGVtKGNtLCBsaW5lT2JqLCBtLCBjb250ZXh0KTtcbiAgICB9XG4gICAgZnVuY3Rpb24gZ2V0QmlkaShjaCwgcGFydFBvcykge1xuICAgICAgdmFyIHBhcnQgPSBvcmRlcltwYXJ0UG9zXSwgcmlnaHQgPSBwYXJ0LmxldmVsICUgMjtcbiAgICAgIGlmIChjaCA9PSBiaWRpTGVmdChwYXJ0KSAmJiBwYXJ0UG9zICYmIHBhcnQubGV2ZWwgPCBvcmRlcltwYXJ0UG9zIC0gMV0ubGV2ZWwpIHtcbiAgICAgICAgcGFydCA9IG9yZGVyWy0tcGFydFBvc107XG4gICAgICAgIGNoID0gYmlkaVJpZ2h0KHBhcnQpIC0gKHBhcnQubGV2ZWwgJSAyID8gMCA6IDEpO1xuICAgICAgICByaWdodCA9IHRydWU7XG4gICAgICB9IGVsc2UgaWYgKGNoID09IGJpZGlSaWdodChwYXJ0KSAmJiBwYXJ0UG9zIDwgb3JkZXIubGVuZ3RoIC0gMSAmJiBwYXJ0LmxldmVsIDwgb3JkZXJbcGFydFBvcyArIDFdLmxldmVsKSB7XG4gICAgICAgIHBhcnQgPSBvcmRlclsrK3BhcnRQb3NdO1xuICAgICAgICBjaCA9IGJpZGlMZWZ0KHBhcnQpIC0gcGFydC5sZXZlbCAlIDI7XG4gICAgICAgIHJpZ2h0ID0gZmFsc2U7XG4gICAgICB9XG4gICAgICBpZiAocmlnaHQgJiYgY2ggPT0gcGFydC50byAmJiBjaCA+IHBhcnQuZnJvbSkgcmV0dXJuIGdldChjaCAtIDEpO1xuICAgICAgcmV0dXJuIGdldChjaCwgcmlnaHQpO1xuICAgIH1cbiAgICB2YXIgb3JkZXIgPSBnZXRPcmRlcihsaW5lT2JqKSwgY2ggPSBwb3MuY2g7XG4gICAgaWYgKCFvcmRlcikgcmV0dXJuIGdldChjaCk7XG4gICAgdmFyIHBhcnRQb3MgPSBnZXRCaWRpUGFydEF0KG9yZGVyLCBjaCk7XG4gICAgdmFyIHZhbCA9IGdldEJpZGkoY2gsIHBhcnRQb3MpO1xuICAgIGlmIChiaWRpT3RoZXIgIT0gbnVsbCkgdmFsLm90aGVyID0gZ2V0QmlkaShjaCwgYmlkaU90aGVyKTtcbiAgICByZXR1cm4gdmFsO1xuICB9XG5cbiAgZnVuY3Rpb24gUG9zV2l0aEluZm8obGluZSwgY2gsIG91dHNpZGUsIHhSZWwpIHtcbiAgICB2YXIgcG9zID0gbmV3IFBvcyhsaW5lLCBjaCk7XG4gICAgcG9zLnhSZWwgPSB4UmVsO1xuICAgIGlmIChvdXRzaWRlKSBwb3Mub3V0c2lkZSA9IHRydWU7XG4gICAgcmV0dXJuIHBvcztcbiAgfVxuXG4gIC8vIENvb3JkcyBtdXN0IGJlIGxpbmVTcGFjZS1sb2NhbFxuICBmdW5jdGlvbiBjb29yZHNDaGFyKGNtLCB4LCB5KSB7XG4gICAgdmFyIGRvYyA9IGNtLmRvYztcbiAgICB5ICs9IGNtLmRpc3BsYXkudmlld09mZnNldDtcbiAgICBpZiAoeSA8IDApIHJldHVybiBQb3NXaXRoSW5mbyhkb2MuZmlyc3QsIDAsIHRydWUsIC0xKTtcbiAgICB2YXIgbGluZU5vID0gbGluZUF0SGVpZ2h0KGRvYywgeSksIGxhc3QgPSBkb2MuZmlyc3QgKyBkb2Muc2l6ZSAtIDE7XG4gICAgaWYgKGxpbmVObyA+IGxhc3QpXG4gICAgICByZXR1cm4gUG9zV2l0aEluZm8oZG9jLmZpcnN0ICsgZG9jLnNpemUgLSAxLCBnZXRMaW5lKGRvYywgbGFzdCkudGV4dC5sZW5ndGgsIHRydWUsIDEpO1xuICAgIGlmICh4IDwgMCkgeCA9IDA7XG5cbiAgICBmb3IgKDs7KSB7XG4gICAgICB2YXIgbGluZU9iaiA9IGdldExpbmUoZG9jLCBsaW5lTm8pO1xuICAgICAgdmFyIGZvdW5kID0gY29vcmRzQ2hhcklubmVyKGNtLCBsaW5lT2JqLCBsaW5lTm8sIHgsIHkpO1xuICAgICAgdmFyIG1lcmdlZCA9IGNvbGxhcHNlZFNwYW5BdEVuZChsaW5lT2JqKTtcbiAgICAgIHZhciBtZXJnZWRQb3MgPSBtZXJnZWQgJiYgbWVyZ2VkLmZpbmQoKTtcbiAgICAgIGlmIChtZXJnZWQgJiYgKGZvdW5kLmNoID4gbWVyZ2VkUG9zLmZyb20uY2ggfHwgZm91bmQuY2ggPT0gbWVyZ2VkUG9zLmZyb20uY2ggJiYgZm91bmQueFJlbCA+IDApKVxuICAgICAgICBsaW5lTm8gPSBtZXJnZWRQb3MudG8ubGluZTtcbiAgICAgIGVsc2VcbiAgICAgICAgcmV0dXJuIGZvdW5kO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGNvb3Jkc0NoYXJJbm5lcihjbSwgbGluZU9iaiwgbGluZU5vLCB4LCB5KSB7XG4gICAgdmFyIGlubmVyT2ZmID0geSAtIGhlaWdodEF0TGluZShjbSwgbGluZU9iaik7XG4gICAgdmFyIHdyb25nTGluZSA9IGZhbHNlLCBhZGp1c3QgPSAyICogY20uZGlzcGxheS53cmFwcGVyLmNsaWVudFdpZHRoO1xuICAgIHZhciBtZWFzdXJlbWVudCA9IG1lYXN1cmVMaW5lKGNtLCBsaW5lT2JqKTtcblxuICAgIGZ1bmN0aW9uIGdldFgoY2gpIHtcbiAgICAgIHZhciBzcCA9IGN1cnNvckNvb3JkcyhjbSwgUG9zKGxpbmVObywgY2gpLCBcImxpbmVcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsaW5lT2JqLCBtZWFzdXJlbWVudCk7XG4gICAgICB3cm9uZ0xpbmUgPSB0cnVlO1xuICAgICAgaWYgKGlubmVyT2ZmID4gc3AuYm90dG9tKSByZXR1cm4gc3AubGVmdCAtIGFkanVzdDtcbiAgICAgIGVsc2UgaWYgKGlubmVyT2ZmIDwgc3AudG9wKSByZXR1cm4gc3AubGVmdCArIGFkanVzdDtcbiAgICAgIGVsc2Ugd3JvbmdMaW5lID0gZmFsc2U7XG4gICAgICByZXR1cm4gc3AubGVmdDtcbiAgICB9XG5cbiAgICB2YXIgYmlkaSA9IGdldE9yZGVyKGxpbmVPYmopLCBkaXN0ID0gbGluZU9iai50ZXh0Lmxlbmd0aDtcbiAgICB2YXIgZnJvbSA9IGxpbmVMZWZ0KGxpbmVPYmopLCB0byA9IGxpbmVSaWdodChsaW5lT2JqKTtcbiAgICB2YXIgZnJvbVggPSBnZXRYKGZyb20pLCBmcm9tT3V0c2lkZSA9IHdyb25nTGluZSwgdG9YID0gZ2V0WCh0byksIHRvT3V0c2lkZSA9IHdyb25nTGluZTtcblxuICAgIGlmICh4ID4gdG9YKSByZXR1cm4gUG9zV2l0aEluZm8obGluZU5vLCB0bywgdG9PdXRzaWRlLCAxKTtcbiAgICAvLyBEbyBhIGJpbmFyeSBzZWFyY2ggYmV0d2VlbiB0aGVzZSBib3VuZHMuXG4gICAgZm9yICg7Oykge1xuICAgICAgaWYgKGJpZGkgPyB0byA9PSBmcm9tIHx8IHRvID09IG1vdmVWaXN1YWxseShsaW5lT2JqLCBmcm9tLCAxKSA6IHRvIC0gZnJvbSA8PSAxKSB7XG4gICAgICAgIHZhciBjaCA9IHggPCBmcm9tWCB8fCB4IC0gZnJvbVggPD0gdG9YIC0geCA/IGZyb20gOiB0bztcbiAgICAgICAgdmFyIHhEaWZmID0geCAtIChjaCA9PSBmcm9tID8gZnJvbVggOiB0b1gpO1xuICAgICAgICB3aGlsZSAoaXNFeHRlbmRpbmdDaGFyKGxpbmVPYmoudGV4dC5jaGFyQXQoY2gpKSkgKytjaDtcbiAgICAgICAgdmFyIHBvcyA9IFBvc1dpdGhJbmZvKGxpbmVObywgY2gsIGNoID09IGZyb20gPyBmcm9tT3V0c2lkZSA6IHRvT3V0c2lkZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHhEaWZmIDwgMCA/IC0xIDogeERpZmYgPyAxIDogMCk7XG4gICAgICAgIHJldHVybiBwb3M7XG4gICAgICB9XG4gICAgICB2YXIgc3RlcCA9IE1hdGguY2VpbChkaXN0IC8gMiksIG1pZGRsZSA9IGZyb20gKyBzdGVwO1xuICAgICAgaWYgKGJpZGkpIHtcbiAgICAgICAgbWlkZGxlID0gZnJvbTtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBzdGVwOyArK2kpIG1pZGRsZSA9IG1vdmVWaXN1YWxseShsaW5lT2JqLCBtaWRkbGUsIDEpO1xuICAgICAgfVxuICAgICAgdmFyIG1pZGRsZVggPSBnZXRYKG1pZGRsZSk7XG4gICAgICBpZiAobWlkZGxlWCA+IHgpIHt0byA9IG1pZGRsZTsgdG9YID0gbWlkZGxlWDsgaWYgKHRvT3V0c2lkZSA9IHdyb25nTGluZSkgdG9YICs9IDEwMDA7IGRpc3QgPSBzdGVwO31cbiAgICAgIGVsc2Uge2Zyb20gPSBtaWRkbGU7IGZyb21YID0gbWlkZGxlWDsgZnJvbU91dHNpZGUgPSB3cm9uZ0xpbmU7IGRpc3QgLT0gc3RlcDt9XG4gICAgfVxuICB9XG5cbiAgdmFyIG1lYXN1cmVUZXh0O1xuICBmdW5jdGlvbiB0ZXh0SGVpZ2h0KGRpc3BsYXkpIHtcbiAgICBpZiAoZGlzcGxheS5jYWNoZWRUZXh0SGVpZ2h0ICE9IG51bGwpIHJldHVybiBkaXNwbGF5LmNhY2hlZFRleHRIZWlnaHQ7XG4gICAgaWYgKG1lYXN1cmVUZXh0ID09IG51bGwpIHtcbiAgICAgIG1lYXN1cmVUZXh0ID0gZWx0KFwicHJlXCIpO1xuICAgICAgLy8gTWVhc3VyZSBhIGJ1bmNoIG9mIGxpbmVzLCBmb3IgYnJvd3NlcnMgdGhhdCBjb21wdXRlXG4gICAgICAvLyBmcmFjdGlvbmFsIGhlaWdodHMuXG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IDQ5OyArK2kpIHtcbiAgICAgICAgbWVhc3VyZVRleHQuYXBwZW5kQ2hpbGQoZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUoXCJ4XCIpKTtcbiAgICAgICAgbWVhc3VyZVRleHQuYXBwZW5kQ2hpbGQoZWx0KFwiYnJcIikpO1xuICAgICAgfVxuICAgICAgbWVhc3VyZVRleHQuYXBwZW5kQ2hpbGQoZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUoXCJ4XCIpKTtcbiAgICB9XG4gICAgcmVtb3ZlQ2hpbGRyZW5BbmRBZGQoZGlzcGxheS5tZWFzdXJlLCBtZWFzdXJlVGV4dCk7XG4gICAgdmFyIGhlaWdodCA9IG1lYXN1cmVUZXh0Lm9mZnNldEhlaWdodCAvIDUwO1xuICAgIGlmIChoZWlnaHQgPiAzKSBkaXNwbGF5LmNhY2hlZFRleHRIZWlnaHQgPSBoZWlnaHQ7XG4gICAgcmVtb3ZlQ2hpbGRyZW4oZGlzcGxheS5tZWFzdXJlKTtcbiAgICByZXR1cm4gaGVpZ2h0IHx8IDE7XG4gIH1cblxuICBmdW5jdGlvbiBjaGFyV2lkdGgoZGlzcGxheSkge1xuICAgIGlmIChkaXNwbGF5LmNhY2hlZENoYXJXaWR0aCAhPSBudWxsKSByZXR1cm4gZGlzcGxheS5jYWNoZWRDaGFyV2lkdGg7XG4gICAgdmFyIGFuY2hvciA9IGVsdChcInNwYW5cIiwgXCJ4XCIpO1xuICAgIHZhciBwcmUgPSBlbHQoXCJwcmVcIiwgW2FuY2hvcl0pO1xuICAgIHJlbW92ZUNoaWxkcmVuQW5kQWRkKGRpc3BsYXkubWVhc3VyZSwgcHJlKTtcbiAgICB2YXIgd2lkdGggPSBhbmNob3Iub2Zmc2V0V2lkdGg7XG4gICAgaWYgKHdpZHRoID4gMikgZGlzcGxheS5jYWNoZWRDaGFyV2lkdGggPSB3aWR0aDtcbiAgICByZXR1cm4gd2lkdGggfHwgMTA7XG4gIH1cblxuICAvLyBPUEVSQVRJT05TXG5cbiAgLy8gT3BlcmF0aW9ucyBhcmUgdXNlZCB0byB3cmFwIGNoYW5nZXMgaW4gc3VjaCBhIHdheSB0aGF0IGVhY2hcbiAgLy8gY2hhbmdlIHdvbid0IGhhdmUgdG8gdXBkYXRlIHRoZSBjdXJzb3IgYW5kIGRpc3BsYXkgKHdoaWNoIHdvdWxkXG4gIC8vIGJlIGF3a3dhcmQsIHNsb3csIGFuZCBlcnJvci1wcm9uZSksIGJ1dCBpbnN0ZWFkIHVwZGF0ZXMgYXJlXG4gIC8vIGJhdGNoZWQgYW5kIHRoZW4gYWxsIGNvbWJpbmVkIGFuZCBleGVjdXRlZCBhdCBvbmNlLlxuXG4gIHZhciBuZXh0T3BJZCA9IDA7XG4gIGZ1bmN0aW9uIHN0YXJ0T3BlcmF0aW9uKGNtKSB7XG4gICAgY20uY3VyT3AgPSB7XG4gICAgICAvLyBBbiBhcnJheSBvZiByYW5nZXMgb2YgbGluZXMgdGhhdCBoYXZlIHRvIGJlIHVwZGF0ZWQuIFNlZVxuICAgICAgLy8gdXBkYXRlRGlzcGxheS5cbiAgICAgIGNoYW5nZXM6IFtdLFxuICAgICAgZm9yY2VVcGRhdGU6IGZhbHNlLFxuICAgICAgdXBkYXRlSW5wdXQ6IG51bGwsXG4gICAgICB1c2VyU2VsQ2hhbmdlOiBudWxsLFxuICAgICAgdGV4dENoYW5nZWQ6IG51bGwsXG4gICAgICBzZWxlY3Rpb25DaGFuZ2VkOiBmYWxzZSxcbiAgICAgIGN1cnNvckFjdGl2aXR5OiBmYWxzZSxcbiAgICAgIHVwZGF0ZU1heExpbmU6IGZhbHNlLFxuICAgICAgdXBkYXRlU2Nyb2xsUG9zOiBmYWxzZSxcbiAgICAgIGlkOiArK25leHRPcElkXG4gICAgfTtcbiAgICBpZiAoIWRlbGF5ZWRDYWxsYmFja0RlcHRoKyspIGRlbGF5ZWRDYWxsYmFja3MgPSBbXTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGVuZE9wZXJhdGlvbihjbSkge1xuICAgIHZhciBvcCA9IGNtLmN1ck9wLCBkb2MgPSBjbS5kb2MsIGRpc3BsYXkgPSBjbS5kaXNwbGF5O1xuICAgIGNtLmN1ck9wID0gbnVsbDtcblxuICAgIGlmIChvcC51cGRhdGVNYXhMaW5lKSBjb21wdXRlTWF4TGVuZ3RoKGNtKTtcbiAgICBpZiAoZGlzcGxheS5tYXhMaW5lQ2hhbmdlZCAmJiAhY20ub3B0aW9ucy5saW5lV3JhcHBpbmcgJiYgZGlzcGxheS5tYXhMaW5lKSB7XG4gICAgICB2YXIgd2lkdGggPSBtZWFzdXJlTGluZVdpZHRoKGNtLCBkaXNwbGF5Lm1heExpbmUpO1xuICAgICAgZGlzcGxheS5zaXplci5zdHlsZS5taW5XaWR0aCA9IE1hdGgubWF4KDAsIHdpZHRoICsgMykgKyBcInB4XCI7XG4gICAgICBkaXNwbGF5Lm1heExpbmVDaGFuZ2VkID0gZmFsc2U7XG4gICAgICB2YXIgbWF4U2Nyb2xsTGVmdCA9IE1hdGgubWF4KDAsIGRpc3BsYXkuc2l6ZXIub2Zmc2V0TGVmdCArIGRpc3BsYXkuc2l6ZXIub2Zmc2V0V2lkdGggLSBkaXNwbGF5LnNjcm9sbGVyLmNsaWVudFdpZHRoKTtcbiAgICAgIGlmIChtYXhTY3JvbGxMZWZ0IDwgZG9jLnNjcm9sbExlZnQgJiYgIW9wLnVwZGF0ZVNjcm9sbFBvcylcbiAgICAgICAgc2V0U2Nyb2xsTGVmdChjbSwgTWF0aC5taW4oZGlzcGxheS5zY3JvbGxlci5zY3JvbGxMZWZ0LCBtYXhTY3JvbGxMZWZ0KSwgdHJ1ZSk7XG4gICAgfVxuICAgIHZhciBuZXdTY3JvbGxQb3MsIHVwZGF0ZWQ7XG4gICAgaWYgKG9wLnVwZGF0ZVNjcm9sbFBvcykge1xuICAgICAgbmV3U2Nyb2xsUG9zID0gb3AudXBkYXRlU2Nyb2xsUG9zO1xuICAgIH0gZWxzZSBpZiAob3Auc2VsZWN0aW9uQ2hhbmdlZCAmJiBkaXNwbGF5LnNjcm9sbGVyLmNsaWVudEhlaWdodCkgeyAvLyBkb24ndCByZXNjcm9sbCBpZiBub3QgdmlzaWJsZVxuICAgICAgdmFyIGNvb3JkcyA9IGN1cnNvckNvb3JkcyhjbSwgZG9jLnNlbC5oZWFkKTtcbiAgICAgIG5ld1Njcm9sbFBvcyA9IGNhbGN1bGF0ZVNjcm9sbFBvcyhjbSwgY29vcmRzLmxlZnQsIGNvb3Jkcy50b3AsIGNvb3Jkcy5sZWZ0LCBjb29yZHMuYm90dG9tKTtcbiAgICB9XG4gICAgaWYgKG9wLmNoYW5nZXMubGVuZ3RoIHx8IG9wLmZvcmNlVXBkYXRlIHx8IG5ld1Njcm9sbFBvcyAmJiBuZXdTY3JvbGxQb3Muc2Nyb2xsVG9wICE9IG51bGwpIHtcbiAgICAgIHVwZGF0ZWQgPSB1cGRhdGVEaXNwbGF5KGNtLCBvcC5jaGFuZ2VzLCBuZXdTY3JvbGxQb3MgJiYgbmV3U2Nyb2xsUG9zLnNjcm9sbFRvcCwgb3AuZm9yY2VVcGRhdGUpO1xuICAgICAgaWYgKGNtLmRpc3BsYXkuc2Nyb2xsZXIub2Zmc2V0SGVpZ2h0KSBjbS5kb2Muc2Nyb2xsVG9wID0gY20uZGlzcGxheS5zY3JvbGxlci5zY3JvbGxUb3A7XG4gICAgfVxuICAgIGlmICghdXBkYXRlZCAmJiBvcC5zZWxlY3Rpb25DaGFuZ2VkKSB1cGRhdGVTZWxlY3Rpb24oY20pO1xuICAgIGlmIChvcC51cGRhdGVTY3JvbGxQb3MpIHtcbiAgICAgIHZhciB0b3AgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihkaXNwbGF5LnNjcm9sbGVyLnNjcm9sbEhlaWdodCAtIGRpc3BsYXkuc2Nyb2xsZXIuY2xpZW50SGVpZ2h0LCBuZXdTY3JvbGxQb3Muc2Nyb2xsVG9wKSk7XG4gICAgICB2YXIgbGVmdCA9IE1hdGgubWF4KDAsIE1hdGgubWluKGRpc3BsYXkuc2Nyb2xsZXIuc2Nyb2xsV2lkdGggLSBkaXNwbGF5LnNjcm9sbGVyLmNsaWVudFdpZHRoLCBuZXdTY3JvbGxQb3Muc2Nyb2xsTGVmdCkpO1xuICAgICAgZGlzcGxheS5zY3JvbGxlci5zY3JvbGxUb3AgPSBkaXNwbGF5LnNjcm9sbGJhclYuc2Nyb2xsVG9wID0gZG9jLnNjcm9sbFRvcCA9IHRvcDtcbiAgICAgIGRpc3BsYXkuc2Nyb2xsZXIuc2Nyb2xsTGVmdCA9IGRpc3BsYXkuc2Nyb2xsYmFySC5zY3JvbGxMZWZ0ID0gZG9jLnNjcm9sbExlZnQgPSBsZWZ0O1xuICAgICAgYWxpZ25Ib3Jpem9udGFsbHkoY20pO1xuICAgICAgaWYgKG9wLnNjcm9sbFRvUG9zKVxuICAgICAgICBzY3JvbGxQb3NJbnRvVmlldyhjbSwgY2xpcFBvcyhjbS5kb2MsIG9wLnNjcm9sbFRvUG9zLmZyb20pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICBjbGlwUG9zKGNtLmRvYywgb3Auc2Nyb2xsVG9Qb3MudG8pLCBvcC5zY3JvbGxUb1Bvcy5tYXJnaW4pO1xuICAgIH0gZWxzZSBpZiAobmV3U2Nyb2xsUG9zKSB7XG4gICAgICBzY3JvbGxDdXJzb3JJbnRvVmlldyhjbSk7XG4gICAgfVxuICAgIGlmIChvcC5zZWxlY3Rpb25DaGFuZ2VkKSByZXN0YXJ0QmxpbmsoY20pO1xuXG4gICAgaWYgKGNtLnN0YXRlLmZvY3VzZWQgJiYgb3AudXBkYXRlSW5wdXQpXG4gICAgICByZXNldElucHV0KGNtLCBvcC51c2VyU2VsQ2hhbmdlKTtcblxuICAgIHZhciBoaWRkZW4gPSBvcC5tYXliZUhpZGRlbk1hcmtlcnMsIHVuaGlkZGVuID0gb3AubWF5YmVVbmhpZGRlbk1hcmtlcnM7XG4gICAgaWYgKGhpZGRlbikgZm9yICh2YXIgaSA9IDA7IGkgPCBoaWRkZW4ubGVuZ3RoOyArK2kpXG4gICAgICBpZiAoIWhpZGRlbltpXS5saW5lcy5sZW5ndGgpIHNpZ25hbChoaWRkZW5baV0sIFwiaGlkZVwiKTtcbiAgICBpZiAodW5oaWRkZW4pIGZvciAodmFyIGkgPSAwOyBpIDwgdW5oaWRkZW4ubGVuZ3RoOyArK2kpXG4gICAgICBpZiAodW5oaWRkZW5baV0ubGluZXMubGVuZ3RoKSBzaWduYWwodW5oaWRkZW5baV0sIFwidW5oaWRlXCIpO1xuXG4gICAgdmFyIGRlbGF5ZWQ7XG4gICAgaWYgKCEtLWRlbGF5ZWRDYWxsYmFja0RlcHRoKSB7XG4gICAgICBkZWxheWVkID0gZGVsYXllZENhbGxiYWNrcztcbiAgICAgIGRlbGF5ZWRDYWxsYmFja3MgPSBudWxsO1xuICAgIH1cbiAgICBpZiAob3AudGV4dENoYW5nZWQpXG4gICAgICBzaWduYWwoY20sIFwiY2hhbmdlXCIsIGNtLCBvcC50ZXh0Q2hhbmdlZCk7XG4gICAgaWYgKG9wLmN1cnNvckFjdGl2aXR5KSBzaWduYWwoY20sIFwiY3Vyc29yQWN0aXZpdHlcIiwgY20pO1xuICAgIGlmIChkZWxheWVkKSBmb3IgKHZhciBpID0gMDsgaSA8IGRlbGF5ZWQubGVuZ3RoOyArK2kpIGRlbGF5ZWRbaV0oKTtcbiAgfVxuXG4gIC8vIFdyYXBzIGEgZnVuY3Rpb24gaW4gYW4gb3BlcmF0aW9uLiBSZXR1cm5zIHRoZSB3cmFwcGVkIGZ1bmN0aW9uLlxuICBmdW5jdGlvbiBvcGVyYXRpb24oY20xLCBmKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIGNtID0gY20xIHx8IHRoaXMsIHdpdGhPcCA9ICFjbS5jdXJPcDtcbiAgICAgIGlmICh3aXRoT3ApIHN0YXJ0T3BlcmF0aW9uKGNtKTtcbiAgICAgIHRyeSB7IHZhciByZXN1bHQgPSBmLmFwcGx5KGNtLCBhcmd1bWVudHMpOyB9XG4gICAgICBmaW5hbGx5IHsgaWYgKHdpdGhPcCkgZW5kT3BlcmF0aW9uKGNtKTsgfVxuICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9O1xuICB9XG4gIGZ1bmN0aW9uIGRvY09wZXJhdGlvbihmKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIHdpdGhPcCA9IHRoaXMuY20gJiYgIXRoaXMuY20uY3VyT3AsIHJlc3VsdDtcbiAgICAgIGlmICh3aXRoT3ApIHN0YXJ0T3BlcmF0aW9uKHRoaXMuY20pO1xuICAgICAgdHJ5IHsgcmVzdWx0ID0gZi5hcHBseSh0aGlzLCBhcmd1bWVudHMpOyB9XG4gICAgICBmaW5hbGx5IHsgaWYgKHdpdGhPcCkgZW5kT3BlcmF0aW9uKHRoaXMuY20pOyB9XG4gICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH07XG4gIH1cbiAgZnVuY3Rpb24gcnVuSW5PcChjbSwgZikge1xuICAgIHZhciB3aXRoT3AgPSAhY20uY3VyT3AsIHJlc3VsdDtcbiAgICBpZiAod2l0aE9wKSBzdGFydE9wZXJhdGlvbihjbSk7XG4gICAgdHJ5IHsgcmVzdWx0ID0gZigpOyB9XG4gICAgZmluYWxseSB7IGlmICh3aXRoT3ApIGVuZE9wZXJhdGlvbihjbSk7IH1cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgZnVuY3Rpb24gcmVnQ2hhbmdlKGNtLCBmcm9tLCB0bywgbGVuZGlmZikge1xuICAgIGlmIChmcm9tID09IG51bGwpIGZyb20gPSBjbS5kb2MuZmlyc3Q7XG4gICAgaWYgKHRvID09IG51bGwpIHRvID0gY20uZG9jLmZpcnN0ICsgY20uZG9jLnNpemU7XG4gICAgY20uY3VyT3AuY2hhbmdlcy5wdXNoKHtmcm9tOiBmcm9tLCB0bzogdG8sIGRpZmY6IGxlbmRpZmZ9KTtcbiAgfVxuXG4gIC8vIElOUFVUIEhBTkRMSU5HXG5cbiAgZnVuY3Rpb24gc2xvd1BvbGwoY20pIHtcbiAgICBpZiAoY20uZGlzcGxheS5wb2xsaW5nRmFzdCkgcmV0dXJuO1xuICAgIGNtLmRpc3BsYXkucG9sbC5zZXQoY20ub3B0aW9ucy5wb2xsSW50ZXJ2YWwsIGZ1bmN0aW9uKCkge1xuICAgICAgcmVhZElucHV0KGNtKTtcbiAgICAgIGlmIChjbS5zdGF0ZS5mb2N1c2VkKSBzbG93UG9sbChjbSk7XG4gICAgfSk7XG4gIH1cblxuICBmdW5jdGlvbiBmYXN0UG9sbChjbSkge1xuICAgIHZhciBtaXNzZWQgPSBmYWxzZTtcbiAgICBjbS5kaXNwbGF5LnBvbGxpbmdGYXN0ID0gdHJ1ZTtcbiAgICBmdW5jdGlvbiBwKCkge1xuICAgICAgdmFyIGNoYW5nZWQgPSByZWFkSW5wdXQoY20pO1xuICAgICAgaWYgKCFjaGFuZ2VkICYmICFtaXNzZWQpIHttaXNzZWQgPSB0cnVlOyBjbS5kaXNwbGF5LnBvbGwuc2V0KDYwLCBwKTt9XG4gICAgICBlbHNlIHtjbS5kaXNwbGF5LnBvbGxpbmdGYXN0ID0gZmFsc2U7IHNsb3dQb2xsKGNtKTt9XG4gICAgfVxuICAgIGNtLmRpc3BsYXkucG9sbC5zZXQoMjAsIHApO1xuICB9XG5cbiAgLy8gcHJldklucHV0IGlzIGEgaGFjayB0byB3b3JrIHdpdGggSU1FLiBJZiB3ZSByZXNldCB0aGUgdGV4dGFyZWFcbiAgLy8gb24gZXZlcnkgY2hhbmdlLCB0aGF0IGJyZWFrcyBJTUUuIFNvIHdlIGxvb2sgZm9yIGNoYW5nZXNcbiAgLy8gY29tcGFyZWQgdG8gdGhlIHByZXZpb3VzIGNvbnRlbnQgaW5zdGVhZC4gKE1vZGVybiBicm93c2VycyBoYXZlXG4gIC8vIGV2ZW50cyB0aGF0IGluZGljYXRlIElNRSB0YWtpbmcgcGxhY2UsIGJ1dCB0aGVzZSBhcmUgbm90IHdpZGVseVxuICAvLyBzdXBwb3J0ZWQgb3IgY29tcGF0aWJsZSBlbm91Z2ggeWV0IHRvIHJlbHkgb24uKVxuICBmdW5jdGlvbiByZWFkSW5wdXQoY20pIHtcbiAgICB2YXIgaW5wdXQgPSBjbS5kaXNwbGF5LmlucHV0LCBwcmV2SW5wdXQgPSBjbS5kaXNwbGF5LnByZXZJbnB1dCwgZG9jID0gY20uZG9jLCBzZWwgPSBkb2Muc2VsO1xuICAgIGlmICghY20uc3RhdGUuZm9jdXNlZCB8fCBoYXNTZWxlY3Rpb24oaW5wdXQpIHx8IGlzUmVhZE9ubHkoY20pIHx8IGNtLm9wdGlvbnMuZGlzYWJsZUlucHV0KSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGNtLnN0YXRlLnBhc3RlSW5jb21pbmcgJiYgY20uc3RhdGUuZmFrZWRMYXN0Q2hhcikge1xuICAgICAgaW5wdXQudmFsdWUgPSBpbnB1dC52YWx1ZS5zdWJzdHJpbmcoMCwgaW5wdXQudmFsdWUubGVuZ3RoIC0gMSk7XG4gICAgICBjbS5zdGF0ZS5mYWtlZExhc3RDaGFyID0gZmFsc2U7XG4gICAgfVxuICAgIHZhciB0ZXh0ID0gaW5wdXQudmFsdWU7XG4gICAgaWYgKHRleHQgPT0gcHJldklucHV0ICYmIHBvc0VxKHNlbC5mcm9tLCBzZWwudG8pKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGllICYmICFpZV9sdDkgJiYgY20uZGlzcGxheS5pbnB1dEhhc1NlbGVjdGlvbiA9PT0gdGV4dCkge1xuICAgICAgcmVzZXRJbnB1dChjbSwgdHJ1ZSk7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgdmFyIHdpdGhPcCA9ICFjbS5jdXJPcDtcbiAgICBpZiAod2l0aE9wKSBzdGFydE9wZXJhdGlvbihjbSk7XG4gICAgc2VsLnNoaWZ0ID0gZmFsc2U7XG4gICAgdmFyIHNhbWUgPSAwLCBsID0gTWF0aC5taW4ocHJldklucHV0Lmxlbmd0aCwgdGV4dC5sZW5ndGgpO1xuICAgIHdoaWxlIChzYW1lIDwgbCAmJiBwcmV2SW5wdXQuY2hhckNvZGVBdChzYW1lKSA9PSB0ZXh0LmNoYXJDb2RlQXQoc2FtZSkpICsrc2FtZTtcbiAgICB2YXIgZnJvbSA9IHNlbC5mcm9tLCB0byA9IHNlbC50bztcbiAgICB2YXIgaW5zZXJ0ZWQgPSB0ZXh0LnNsaWNlKHNhbWUpO1xuICAgIGlmIChzYW1lIDwgcHJldklucHV0Lmxlbmd0aClcbiAgICAgIGZyb20gPSBQb3MoZnJvbS5saW5lLCBmcm9tLmNoIC0gKHByZXZJbnB1dC5sZW5ndGggLSBzYW1lKSk7XG4gICAgZWxzZSBpZiAoY20uc3RhdGUub3ZlcndyaXRlICYmIHBvc0VxKGZyb20sIHRvKSAmJiAhY20uc3RhdGUucGFzdGVJbmNvbWluZylcbiAgICAgIHRvID0gUG9zKHRvLmxpbmUsIE1hdGgubWluKGdldExpbmUoZG9jLCB0by5saW5lKS50ZXh0Lmxlbmd0aCwgdG8uY2ggKyBpbnNlcnRlZC5sZW5ndGgpKTtcblxuICAgIHZhciB1cGRhdGVJbnB1dCA9IGNtLmN1ck9wLnVwZGF0ZUlucHV0O1xuICAgIHZhciBjaGFuZ2VFdmVudCA9IHtmcm9tOiBmcm9tLCB0bzogdG8sIHRleHQ6IHNwbGl0TGluZXMoaW5zZXJ0ZWQpLFxuICAgICAgICAgICAgICAgICAgICAgICBvcmlnaW46IGNtLnN0YXRlLnBhc3RlSW5jb21pbmcgPyBcInBhc3RlXCIgOiBjbS5zdGF0ZS5jdXRJbmNvbWluZyA/IFwiY3V0XCIgOiBcIitpbnB1dFwifTtcbiAgICBtYWtlQ2hhbmdlKGNtLmRvYywgY2hhbmdlRXZlbnQsIFwiZW5kXCIpO1xuICAgIGNtLmN1ck9wLnVwZGF0ZUlucHV0ID0gdXBkYXRlSW5wdXQ7XG4gICAgc2lnbmFsTGF0ZXIoY20sIFwiaW5wdXRSZWFkXCIsIGNtLCBjaGFuZ2VFdmVudCk7XG4gICAgaWYgKGluc2VydGVkICYmICFjbS5zdGF0ZS5wYXN0ZUluY29taW5nICYmIGNtLm9wdGlvbnMuZWxlY3RyaWNDaGFycyAmJlxuICAgICAgICBjbS5vcHRpb25zLnNtYXJ0SW5kZW50ICYmIHNlbC5oZWFkLmNoIDwgMTAwKSB7XG4gICAgICB2YXIgZWxlY3RyaWMgPSBjbS5nZXRNb2RlQXQoc2VsLmhlYWQpLmVsZWN0cmljQ2hhcnM7XG4gICAgICBpZiAoZWxlY3RyaWMpIGZvciAodmFyIGkgPSAwOyBpIDwgZWxlY3RyaWMubGVuZ3RoOyBpKyspXG4gICAgICAgIGlmIChpbnNlcnRlZC5pbmRleE9mKGVsZWN0cmljLmNoYXJBdChpKSkgPiAtMSkge1xuICAgICAgICAgIGluZGVudExpbmUoY20sIHNlbC5oZWFkLmxpbmUsIFwic21hcnRcIik7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAodGV4dC5sZW5ndGggPiAxMDAwIHx8IHRleHQuaW5kZXhPZihcIlxcblwiKSA+IC0xKSBpbnB1dC52YWx1ZSA9IGNtLmRpc3BsYXkucHJldklucHV0ID0gXCJcIjtcbiAgICBlbHNlIGNtLmRpc3BsYXkucHJldklucHV0ID0gdGV4dDtcbiAgICBpZiAod2l0aE9wKSBlbmRPcGVyYXRpb24oY20pO1xuICAgIGNtLnN0YXRlLnBhc3RlSW5jb21pbmcgPSBjbS5zdGF0ZS5jdXRJbmNvbWluZyA9IGZhbHNlO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgZnVuY3Rpb24gcmVzZXRJbnB1dChjbSwgdXNlcikge1xuICAgIHZhciBtaW5pbWFsLCBzZWxlY3RlZCwgZG9jID0gY20uZG9jO1xuICAgIGlmICghcG9zRXEoZG9jLnNlbC5mcm9tLCBkb2Muc2VsLnRvKSkge1xuICAgICAgY20uZGlzcGxheS5wcmV2SW5wdXQgPSBcIlwiO1xuICAgICAgbWluaW1hbCA9IGhhc0NvcHlFdmVudCAmJlxuICAgICAgICAoZG9jLnNlbC50by5saW5lIC0gZG9jLnNlbC5mcm9tLmxpbmUgPiAxMDAgfHwgKHNlbGVjdGVkID0gY20uZ2V0U2VsZWN0aW9uKCkpLmxlbmd0aCA+IDEwMDApO1xuICAgICAgdmFyIGNvbnRlbnQgPSBtaW5pbWFsID8gXCItXCIgOiBzZWxlY3RlZCB8fCBjbS5nZXRTZWxlY3Rpb24oKTtcbiAgICAgIGNtLmRpc3BsYXkuaW5wdXQudmFsdWUgPSBjb250ZW50O1xuICAgICAgaWYgKGNtLnN0YXRlLmZvY3VzZWQpIHNlbGVjdElucHV0KGNtLmRpc3BsYXkuaW5wdXQpO1xuICAgICAgaWYgKGllICYmICFpZV9sdDkpIGNtLmRpc3BsYXkuaW5wdXRIYXNTZWxlY3Rpb24gPSBjb250ZW50O1xuICAgIH0gZWxzZSBpZiAodXNlcikge1xuICAgICAgY20uZGlzcGxheS5wcmV2SW5wdXQgPSBjbS5kaXNwbGF5LmlucHV0LnZhbHVlID0gXCJcIjtcbiAgICAgIGlmIChpZSAmJiAhaWVfbHQ5KSBjbS5kaXNwbGF5LmlucHV0SGFzU2VsZWN0aW9uID0gbnVsbDtcbiAgICB9XG4gICAgY20uZGlzcGxheS5pbmFjY3VyYXRlU2VsZWN0aW9uID0gbWluaW1hbDtcbiAgfVxuXG4gIGZ1bmN0aW9uIGZvY3VzSW5wdXQoY20pIHtcbiAgICBpZiAoY20ub3B0aW9ucy5yZWFkT25seSAhPSBcIm5vY3Vyc29yXCIgJiYgKCFtb2JpbGUgfHwgZG9jdW1lbnQuYWN0aXZlRWxlbWVudCAhPSBjbS5kaXNwbGF5LmlucHV0KSlcbiAgICAgIGNtLmRpc3BsYXkuaW5wdXQuZm9jdXMoKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGVuc3VyZUZvY3VzKGNtKSB7XG4gICAgaWYgKCFjbS5zdGF0ZS5mb2N1c2VkKSB7IGZvY3VzSW5wdXQoY20pOyBvbkZvY3VzKGNtKTsgfVxuICB9XG5cbiAgZnVuY3Rpb24gaXNSZWFkT25seShjbSkge1xuICAgIHJldHVybiBjbS5vcHRpb25zLnJlYWRPbmx5IHx8IGNtLmRvYy5jYW50RWRpdDtcbiAgfVxuXG4gIC8vIEVWRU5UIEhBTkRMRVJTXG5cbiAgZnVuY3Rpb24gcmVnaXN0ZXJFdmVudEhhbmRsZXJzKGNtKSB7XG4gICAgdmFyIGQgPSBjbS5kaXNwbGF5O1xuICAgIG9uKGQuc2Nyb2xsZXIsIFwibW91c2Vkb3duXCIsIG9wZXJhdGlvbihjbSwgb25Nb3VzZURvd24pKTtcbiAgICBpZiAob2xkX2llKVxuICAgICAgb24oZC5zY3JvbGxlciwgXCJkYmxjbGlja1wiLCBvcGVyYXRpb24oY20sIGZ1bmN0aW9uKGUpIHtcbiAgICAgICAgaWYgKHNpZ25hbERPTUV2ZW50KGNtLCBlKSkgcmV0dXJuO1xuICAgICAgICB2YXIgcG9zID0gcG9zRnJvbU1vdXNlKGNtLCBlKTtcbiAgICAgICAgaWYgKCFwb3MgfHwgY2xpY2tJbkd1dHRlcihjbSwgZSkgfHwgZXZlbnRJbldpZGdldChjbS5kaXNwbGF5LCBlKSkgcmV0dXJuO1xuICAgICAgICBlX3ByZXZlbnREZWZhdWx0KGUpO1xuICAgICAgICB2YXIgd29yZCA9IGZpbmRXb3JkQXQoZ2V0TGluZShjbS5kb2MsIHBvcy5saW5lKS50ZXh0LCBwb3MpO1xuICAgICAgICBleHRlbmRTZWxlY3Rpb24oY20uZG9jLCB3b3JkLmZyb20sIHdvcmQudG8pO1xuICAgICAgfSkpO1xuICAgIGVsc2VcbiAgICAgIG9uKGQuc2Nyb2xsZXIsIFwiZGJsY2xpY2tcIiwgZnVuY3Rpb24oZSkgeyBzaWduYWxET01FdmVudChjbSwgZSkgfHwgZV9wcmV2ZW50RGVmYXVsdChlKTsgfSk7XG4gICAgb24oZC5saW5lU3BhY2UsIFwic2VsZWN0c3RhcnRcIiwgZnVuY3Rpb24oZSkge1xuICAgICAgaWYgKCFldmVudEluV2lkZ2V0KGQsIGUpKSBlX3ByZXZlbnREZWZhdWx0KGUpO1xuICAgIH0pO1xuICAgIC8vIEdlY2tvIGJyb3dzZXJzIGZpcmUgY29udGV4dG1lbnUgKmFmdGVyKiBvcGVuaW5nIHRoZSBtZW51LCBhdFxuICAgIC8vIHdoaWNoIHBvaW50IHdlIGNhbid0IG1lc3Mgd2l0aCBpdCBhbnltb3JlLiBDb250ZXh0IG1lbnUgaXNcbiAgICAvLyBoYW5kbGVkIGluIG9uTW91c2VEb3duIGZvciBHZWNrby5cbiAgICBpZiAoIWNhcHR1cmVNaWRkbGVDbGljaykgb24oZC5zY3JvbGxlciwgXCJjb250ZXh0bWVudVwiLCBmdW5jdGlvbihlKSB7b25Db250ZXh0TWVudShjbSwgZSk7fSk7XG5cbiAgICBvbihkLnNjcm9sbGVyLCBcInNjcm9sbFwiLCBmdW5jdGlvbigpIHtcbiAgICAgIGlmIChkLnNjcm9sbGVyLmNsaWVudEhlaWdodCkge1xuICAgICAgICBzZXRTY3JvbGxUb3AoY20sIGQuc2Nyb2xsZXIuc2Nyb2xsVG9wKTtcbiAgICAgICAgc2V0U2Nyb2xsTGVmdChjbSwgZC5zY3JvbGxlci5zY3JvbGxMZWZ0LCB0cnVlKTtcbiAgICAgICAgc2lnbmFsKGNtLCBcInNjcm9sbFwiLCBjbSk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgb24oZC5zY3JvbGxiYXJWLCBcInNjcm9sbFwiLCBmdW5jdGlvbigpIHtcbiAgICAgIGlmIChkLnNjcm9sbGVyLmNsaWVudEhlaWdodCkgc2V0U2Nyb2xsVG9wKGNtLCBkLnNjcm9sbGJhclYuc2Nyb2xsVG9wKTtcbiAgICB9KTtcbiAgICBvbihkLnNjcm9sbGJhckgsIFwic2Nyb2xsXCIsIGZ1bmN0aW9uKCkge1xuICAgICAgaWYgKGQuc2Nyb2xsZXIuY2xpZW50SGVpZ2h0KSBzZXRTY3JvbGxMZWZ0KGNtLCBkLnNjcm9sbGJhckguc2Nyb2xsTGVmdCk7XG4gICAgfSk7XG5cbiAgICBvbihkLnNjcm9sbGVyLCBcIm1vdXNld2hlZWxcIiwgZnVuY3Rpb24oZSl7b25TY3JvbGxXaGVlbChjbSwgZSk7fSk7XG4gICAgb24oZC5zY3JvbGxlciwgXCJET01Nb3VzZVNjcm9sbFwiLCBmdW5jdGlvbihlKXtvblNjcm9sbFdoZWVsKGNtLCBlKTt9KTtcblxuICAgIGZ1bmN0aW9uIHJlRm9jdXMoKSB7IGlmIChjbS5zdGF0ZS5mb2N1c2VkKSBzZXRUaW1lb3V0KGJpbmQoZm9jdXNJbnB1dCwgY20pLCAwKTsgfVxuICAgIG9uKGQuc2Nyb2xsYmFySCwgXCJtb3VzZWRvd25cIiwgcmVGb2N1cyk7XG4gICAgb24oZC5zY3JvbGxiYXJWLCBcIm1vdXNlZG93blwiLCByZUZvY3VzKTtcbiAgICAvLyBQcmV2ZW50IHdyYXBwZXIgZnJvbSBldmVyIHNjcm9sbGluZ1xuICAgIG9uKGQud3JhcHBlciwgXCJzY3JvbGxcIiwgZnVuY3Rpb24oKSB7IGQud3JhcHBlci5zY3JvbGxUb3AgPSBkLndyYXBwZXIuc2Nyb2xsTGVmdCA9IDA7IH0pO1xuXG4gICAgdmFyIHJlc2l6ZVRpbWVyO1xuICAgIGZ1bmN0aW9uIG9uUmVzaXplKCkge1xuICAgICAgaWYgKHJlc2l6ZVRpbWVyID09IG51bGwpIHJlc2l6ZVRpbWVyID0gc2V0VGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgICAgcmVzaXplVGltZXIgPSBudWxsO1xuICAgICAgICAvLyBNaWdodCBiZSBhIHRleHQgc2NhbGluZyBvcGVyYXRpb24sIGNsZWFyIHNpemUgY2FjaGVzLlxuICAgICAgICBkLmNhY2hlZENoYXJXaWR0aCA9IGQuY2FjaGVkVGV4dEhlaWdodCA9IGQuY2FjaGVkUGFkZGluZ0ggPSBrbm93blNjcm9sbGJhcldpZHRoID0gbnVsbDtcbiAgICAgICAgY2xlYXJDYWNoZXMoY20pO1xuICAgICAgICBydW5Jbk9wKGNtLCBiaW5kKHJlZ0NoYW5nZSwgY20pKTtcbiAgICAgIH0sIDEwMCk7XG4gICAgfVxuICAgIG9uKHdpbmRvdywgXCJyZXNpemVcIiwgb25SZXNpemUpO1xuICAgIC8vIEFib3ZlIGhhbmRsZXIgaG9sZHMgb24gdG8gdGhlIGVkaXRvciBhbmQgaXRzIGRhdGEgc3RydWN0dXJlcy5cbiAgICAvLyBIZXJlIHdlIHBvbGwgdG8gdW5yZWdpc3RlciBpdCB3aGVuIHRoZSBlZGl0b3IgaXMgbm8gbG9uZ2VyIGluXG4gICAgLy8gdGhlIGRvY3VtZW50LCBzbyB0aGF0IGl0IGNhbiBiZSBnYXJiYWdlLWNvbGxlY3RlZC5cbiAgICBmdW5jdGlvbiB1bnJlZ2lzdGVyKCkge1xuICAgICAgZm9yICh2YXIgcCA9IGQud3JhcHBlci5wYXJlbnROb2RlOyBwICYmIHAgIT0gZG9jdW1lbnQuYm9keTsgcCA9IHAucGFyZW50Tm9kZSkge31cbiAgICAgIGlmIChwKSBzZXRUaW1lb3V0KHVucmVnaXN0ZXIsIDUwMDApO1xuICAgICAgZWxzZSBvZmYod2luZG93LCBcInJlc2l6ZVwiLCBvblJlc2l6ZSk7XG4gICAgfVxuICAgIHNldFRpbWVvdXQodW5yZWdpc3RlciwgNTAwMCk7XG5cbiAgICBvbihkLmlucHV0LCBcImtleXVwXCIsIG9wZXJhdGlvbihjbSwgb25LZXlVcCkpO1xuICAgIG9uKGQuaW5wdXQsIFwiaW5wdXRcIiwgZnVuY3Rpb24oKSB7XG4gICAgICBpZiAoaWUgJiYgIWllX2x0OSAmJiBjbS5kaXNwbGF5LmlucHV0SGFzU2VsZWN0aW9uKSBjbS5kaXNwbGF5LmlucHV0SGFzU2VsZWN0aW9uID0gbnVsbDtcbiAgICAgIGZhc3RQb2xsKGNtKTtcbiAgICB9KTtcbiAgICBvbihkLmlucHV0LCBcImtleWRvd25cIiwgb3BlcmF0aW9uKGNtLCBvbktleURvd24pKTtcbiAgICBvbihkLmlucHV0LCBcImtleXByZXNzXCIsIG9wZXJhdGlvbihjbSwgb25LZXlQcmVzcykpO1xuICAgIG9uKGQuaW5wdXQsIFwiZm9jdXNcIiwgYmluZChvbkZvY3VzLCBjbSkpO1xuICAgIG9uKGQuaW5wdXQsIFwiYmx1clwiLCBiaW5kKG9uQmx1ciwgY20pKTtcblxuICAgIGZ1bmN0aW9uIGRyYWdfKGUpIHtcbiAgICAgIGlmIChzaWduYWxET01FdmVudChjbSwgZSkgfHwgY20ub3B0aW9ucy5vbkRyYWdFdmVudCAmJiBjbS5vcHRpb25zLm9uRHJhZ0V2ZW50KGNtLCBhZGRTdG9wKGUpKSkgcmV0dXJuO1xuICAgICAgZV9zdG9wKGUpO1xuICAgIH1cbiAgICBpZiAoY20ub3B0aW9ucy5kcmFnRHJvcCkge1xuICAgICAgb24oZC5zY3JvbGxlciwgXCJkcmFnc3RhcnRcIiwgZnVuY3Rpb24oZSl7b25EcmFnU3RhcnQoY20sIGUpO30pO1xuICAgICAgb24oZC5zY3JvbGxlciwgXCJkcmFnZW50ZXJcIiwgZHJhZ18pO1xuICAgICAgb24oZC5zY3JvbGxlciwgXCJkcmFnb3ZlclwiLCBkcmFnXyk7XG4gICAgICBvbihkLnNjcm9sbGVyLCBcImRyb3BcIiwgb3BlcmF0aW9uKGNtLCBvbkRyb3ApKTtcbiAgICB9XG4gICAgb24oZC5zY3JvbGxlciwgXCJwYXN0ZVwiLCBmdW5jdGlvbihlKSB7XG4gICAgICBpZiAoZXZlbnRJbldpZGdldChkLCBlKSkgcmV0dXJuO1xuICAgICAgZm9jdXNJbnB1dChjbSk7XG4gICAgICBmYXN0UG9sbChjbSk7XG4gICAgfSk7XG4gICAgb24oZC5pbnB1dCwgXCJwYXN0ZVwiLCBmdW5jdGlvbigpIHtcbiAgICAgIC8vIFdvcmthcm91bmQgZm9yIHdlYmtpdCBidWcgaHR0cHM6Ly9idWdzLndlYmtpdC5vcmcvc2hvd19idWcuY2dpP2lkPTkwMjA2XG4gICAgICAvLyBBZGQgYSBjaGFyIHRvIHRoZSBlbmQgb2YgdGV4dGFyZWEgYmVmb3JlIHBhc3RlIG9jY3VyIHNvIHRoYXRcbiAgICAgIC8vIHNlbGVjdGlvbiBkb2Vzbid0IHNwYW4gdG8gdGhlIGVuZCBvZiB0ZXh0YXJlYS5cbiAgICAgIGlmICh3ZWJraXQgJiYgIWNtLnN0YXRlLmZha2VkTGFzdENoYXIgJiYgIShuZXcgRGF0ZSAtIGNtLnN0YXRlLmxhc3RNaWRkbGVEb3duIDwgMjAwKSkge1xuICAgICAgICB2YXIgc3RhcnQgPSBkLmlucHV0LnNlbGVjdGlvblN0YXJ0LCBlbmQgPSBkLmlucHV0LnNlbGVjdGlvbkVuZDtcbiAgICAgICAgZC5pbnB1dC52YWx1ZSArPSBcIiRcIjtcbiAgICAgICAgZC5pbnB1dC5zZWxlY3Rpb25TdGFydCA9IHN0YXJ0O1xuICAgICAgICBkLmlucHV0LnNlbGVjdGlvbkVuZCA9IGVuZDtcbiAgICAgICAgY20uc3RhdGUuZmFrZWRMYXN0Q2hhciA9IHRydWU7XG4gICAgICB9XG4gICAgICBjbS5zdGF0ZS5wYXN0ZUluY29taW5nID0gdHJ1ZTtcbiAgICAgIGZhc3RQb2xsKGNtKTtcbiAgICB9KTtcblxuICAgIGZ1bmN0aW9uIHByZXBhcmVDb3B5KGUpIHtcbiAgICAgIGlmIChkLmluYWNjdXJhdGVTZWxlY3Rpb24pIHtcbiAgICAgICAgZC5wcmV2SW5wdXQgPSBcIlwiO1xuICAgICAgICBkLmluYWNjdXJhdGVTZWxlY3Rpb24gPSBmYWxzZTtcbiAgICAgICAgZC5pbnB1dC52YWx1ZSA9IGNtLmdldFNlbGVjdGlvbigpO1xuICAgICAgICBzZWxlY3RJbnB1dChkLmlucHV0KTtcbiAgICAgIH1cbiAgICAgIGlmIChlLnR5cGUgPT0gXCJjdXRcIikgY20uc3RhdGUuY3V0SW5jb21pbmcgPSB0cnVlO1xuICAgIH1cbiAgICBvbihkLmlucHV0LCBcImN1dFwiLCBwcmVwYXJlQ29weSk7XG4gICAgb24oZC5pbnB1dCwgXCJjb3B5XCIsIHByZXBhcmVDb3B5KTtcblxuICAgIC8vIE5lZWRlZCB0byBoYW5kbGUgVGFiIGtleSBpbiBLSFRNTFxuICAgIGlmIChraHRtbCkgb24oZC5zaXplciwgXCJtb3VzZXVwXCIsIGZ1bmN0aW9uKCkge1xuICAgICAgaWYgKGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgPT0gZC5pbnB1dCkgZC5pbnB1dC5ibHVyKCk7XG4gICAgICBmb2N1c0lucHV0KGNtKTtcbiAgICB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGV2ZW50SW5XaWRnZXQoZGlzcGxheSwgZSkge1xuICAgIGZvciAodmFyIG4gPSBlX3RhcmdldChlKTsgbiAhPSBkaXNwbGF5LndyYXBwZXI7IG4gPSBuLnBhcmVudE5vZGUpIHtcbiAgICAgIGlmICghbiB8fCBuLmlnbm9yZUV2ZW50cyB8fCBuLnBhcmVudE5vZGUgPT0gZGlzcGxheS5zaXplciAmJiBuICE9IGRpc3BsYXkubW92ZXIpIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHBvc0Zyb21Nb3VzZShjbSwgZSwgbGliZXJhbCkge1xuICAgIHZhciBkaXNwbGF5ID0gY20uZGlzcGxheTtcbiAgICBpZiAoIWxpYmVyYWwpIHtcbiAgICAgIHZhciB0YXJnZXQgPSBlX3RhcmdldChlKTtcbiAgICAgIGlmICh0YXJnZXQgPT0gZGlzcGxheS5zY3JvbGxiYXJIIHx8IHRhcmdldCA9PSBkaXNwbGF5LnNjcm9sbGJhckguZmlyc3RDaGlsZCB8fFxuICAgICAgICAgIHRhcmdldCA9PSBkaXNwbGF5LnNjcm9sbGJhclYgfHwgdGFyZ2V0ID09IGRpc3BsYXkuc2Nyb2xsYmFyVi5maXJzdENoaWxkIHx8XG4gICAgICAgICAgdGFyZ2V0ID09IGRpc3BsYXkuc2Nyb2xsYmFyRmlsbGVyIHx8IHRhcmdldCA9PSBkaXNwbGF5Lmd1dHRlckZpbGxlcikgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIHZhciB4LCB5LCBzcGFjZSA9IGdldFJlY3QoZGlzcGxheS5saW5lU3BhY2UpO1xuICAgIC8vIEZhaWxzIHVucHJlZGljdGFibHkgb24gSUVbNjddIHdoZW4gbW91c2UgaXMgZHJhZ2dlZCBhcm91bmQgcXVpY2tseS5cbiAgICB0cnkgeyB4ID0gZS5jbGllbnRYOyB5ID0gZS5jbGllbnRZOyB9IGNhdGNoIChlKSB7IHJldHVybiBudWxsOyB9XG4gICAgcmV0dXJuIGNvb3Jkc0NoYXIoY20sIHggLSBzcGFjZS5sZWZ0LCB5IC0gc3BhY2UudG9wKTtcbiAgfVxuXG4gIHZhciBsYXN0Q2xpY2ssIGxhc3REb3VibGVDbGljaztcbiAgZnVuY3Rpb24gb25Nb3VzZURvd24oZSkge1xuICAgIGlmIChzaWduYWxET01FdmVudCh0aGlzLCBlKSkgcmV0dXJuO1xuICAgIHZhciBjbSA9IHRoaXMsIGRpc3BsYXkgPSBjbS5kaXNwbGF5LCBkb2MgPSBjbS5kb2MsIHNlbCA9IGRvYy5zZWw7XG4gICAgc2VsLnNoaWZ0ID0gZS5zaGlmdEtleTtcblxuICAgIGlmIChldmVudEluV2lkZ2V0KGRpc3BsYXksIGUpKSB7XG4gICAgICBpZiAoIXdlYmtpdCkge1xuICAgICAgICBkaXNwbGF5LnNjcm9sbGVyLmRyYWdnYWJsZSA9IGZhbHNlO1xuICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCl7ZGlzcGxheS5zY3JvbGxlci5kcmFnZ2FibGUgPSB0cnVlO30sIDEwMCk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChjbGlja0luR3V0dGVyKGNtLCBlKSkgcmV0dXJuO1xuICAgIHZhciBzdGFydCA9IHBvc0Zyb21Nb3VzZShjbSwgZSk7XG4gICAgd2luZG93LmZvY3VzKCk7XG5cbiAgICBzd2l0Y2ggKGVfYnV0dG9uKGUpKSB7XG4gICAgY2FzZSAzOlxuICAgICAgaWYgKGNhcHR1cmVNaWRkbGVDbGljaykgb25Db250ZXh0TWVudS5jYWxsKGNtLCBjbSwgZSk7XG4gICAgICByZXR1cm47XG4gICAgY2FzZSAyOlxuICAgICAgaWYgKHdlYmtpdCkgY20uc3RhdGUubGFzdE1pZGRsZURvd24gPSArbmV3IERhdGU7XG4gICAgICBpZiAoc3RhcnQpIGV4dGVuZFNlbGVjdGlvbihjbS5kb2MsIHN0YXJ0KTtcbiAgICAgIHNldFRpbWVvdXQoYmluZChmb2N1c0lucHV0LCBjbSksIDIwKTtcbiAgICAgIGVfcHJldmVudERlZmF1bHQoZSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIC8vIEZvciBidXR0b24gMSwgaWYgaXQgd2FzIGNsaWNrZWQgaW5zaWRlIHRoZSBlZGl0b3JcbiAgICAvLyAocG9zRnJvbU1vdXNlIHJldHVybmluZyBub24tbnVsbCksIHdlIGhhdmUgdG8gYWRqdXN0IHRoZVxuICAgIC8vIHNlbGVjdGlvbi5cbiAgICBpZiAoIXN0YXJ0KSB7aWYgKGVfdGFyZ2V0KGUpID09IGRpc3BsYXkuc2Nyb2xsZXIpIGVfcHJldmVudERlZmF1bHQoZSk7IHJldHVybjt9XG5cbiAgICBzZXRUaW1lb3V0KGJpbmQoZW5zdXJlRm9jdXMsIGNtKSwgMCk7XG5cbiAgICB2YXIgbm93ID0gK25ldyBEYXRlLCB0eXBlID0gXCJzaW5nbGVcIjtcbiAgICBpZiAobGFzdERvdWJsZUNsaWNrICYmIGxhc3REb3VibGVDbGljay50aW1lID4gbm93IC0gNDAwICYmIHBvc0VxKGxhc3REb3VibGVDbGljay5wb3MsIHN0YXJ0KSkge1xuICAgICAgdHlwZSA9IFwidHJpcGxlXCI7XG4gICAgICBlX3ByZXZlbnREZWZhdWx0KGUpO1xuICAgICAgc2V0VGltZW91dChiaW5kKGZvY3VzSW5wdXQsIGNtKSwgMjApO1xuICAgICAgc2VsZWN0TGluZShjbSwgc3RhcnQubGluZSk7XG4gICAgfSBlbHNlIGlmIChsYXN0Q2xpY2sgJiYgbGFzdENsaWNrLnRpbWUgPiBub3cgLSA0MDAgJiYgcG9zRXEobGFzdENsaWNrLnBvcywgc3RhcnQpKSB7XG4gICAgICB0eXBlID0gXCJkb3VibGVcIjtcbiAgICAgIGxhc3REb3VibGVDbGljayA9IHt0aW1lOiBub3csIHBvczogc3RhcnR9O1xuICAgICAgZV9wcmV2ZW50RGVmYXVsdChlKTtcbiAgICAgIHZhciB3b3JkID0gZmluZFdvcmRBdChnZXRMaW5lKGRvYywgc3RhcnQubGluZSkudGV4dCwgc3RhcnQpO1xuICAgICAgZXh0ZW5kU2VsZWN0aW9uKGNtLmRvYywgd29yZC5mcm9tLCB3b3JkLnRvKTtcbiAgICB9IGVsc2UgeyBsYXN0Q2xpY2sgPSB7dGltZTogbm93LCBwb3M6IHN0YXJ0fTsgfVxuXG4gICAgdmFyIGxhc3QgPSBzdGFydDtcbiAgICBpZiAoY20ub3B0aW9ucy5kcmFnRHJvcCAmJiBkcmFnQW5kRHJvcCAmJiAhaXNSZWFkT25seShjbSkgJiYgIXBvc0VxKHNlbC5mcm9tLCBzZWwudG8pICYmXG4gICAgICAgICFwb3NMZXNzKHN0YXJ0LCBzZWwuZnJvbSkgJiYgIXBvc0xlc3Moc2VsLnRvLCBzdGFydCkgJiYgdHlwZSA9PSBcInNpbmdsZVwiKSB7XG4gICAgICB2YXIgZHJhZ0VuZCA9IG9wZXJhdGlvbihjbSwgZnVuY3Rpb24oZTIpIHtcbiAgICAgICAgaWYgKHdlYmtpdCkgZGlzcGxheS5zY3JvbGxlci5kcmFnZ2FibGUgPSBmYWxzZTtcbiAgICAgICAgY20uc3RhdGUuZHJhZ2dpbmdUZXh0ID0gZmFsc2U7XG4gICAgICAgIG9mZihkb2N1bWVudCwgXCJtb3VzZXVwXCIsIGRyYWdFbmQpO1xuICAgICAgICBvZmYoZGlzcGxheS5zY3JvbGxlciwgXCJkcm9wXCIsIGRyYWdFbmQpO1xuICAgICAgICBpZiAoTWF0aC5hYnMoZS5jbGllbnRYIC0gZTIuY2xpZW50WCkgKyBNYXRoLmFicyhlLmNsaWVudFkgLSBlMi5jbGllbnRZKSA8IDEwKSB7XG4gICAgICAgICAgZV9wcmV2ZW50RGVmYXVsdChlMik7XG4gICAgICAgICAgZXh0ZW5kU2VsZWN0aW9uKGNtLmRvYywgc3RhcnQpO1xuICAgICAgICAgIGZvY3VzSW5wdXQoY20pO1xuICAgICAgICAgIC8vIFdvcmsgYXJvdW5kIHVuZXhwbGFpbmFibGUgZm9jdXMgcHJvYmxlbSBpbiBJRTkgKCMyMTI3KVxuICAgICAgICAgIGlmIChvbGRfaWUgJiYgIWllX2x0OSlcbiAgICAgICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7ZG9jdW1lbnQuYm9keS5mb2N1cygpOyBmb2N1c0lucHV0KGNtKTt9LCAyMCk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgLy8gTGV0IHRoZSBkcmFnIGhhbmRsZXIgaGFuZGxlIHRoaXMuXG4gICAgICBpZiAod2Via2l0KSBkaXNwbGF5LnNjcm9sbGVyLmRyYWdnYWJsZSA9IHRydWU7XG4gICAgICBjbS5zdGF0ZS5kcmFnZ2luZ1RleHQgPSBkcmFnRW5kO1xuICAgICAgLy8gSUUncyBhcHByb2FjaCB0byBkcmFnZ2FibGVcbiAgICAgIGlmIChkaXNwbGF5LnNjcm9sbGVyLmRyYWdEcm9wKSBkaXNwbGF5LnNjcm9sbGVyLmRyYWdEcm9wKCk7XG4gICAgICBvbihkb2N1bWVudCwgXCJtb3VzZXVwXCIsIGRyYWdFbmQpO1xuICAgICAgb24oZGlzcGxheS5zY3JvbGxlciwgXCJkcm9wXCIsIGRyYWdFbmQpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBlX3ByZXZlbnREZWZhdWx0KGUpO1xuICAgIGlmICh0eXBlID09IFwic2luZ2xlXCIpIGV4dGVuZFNlbGVjdGlvbihjbS5kb2MsIGNsaXBQb3MoZG9jLCBzdGFydCkpO1xuXG4gICAgdmFyIHN0YXJ0c3RhcnQgPSBzZWwuZnJvbSwgc3RhcnRlbmQgPSBzZWwudG8sIGxhc3RQb3MgPSBzdGFydDtcblxuICAgIGZ1bmN0aW9uIGRvU2VsZWN0KGN1cikge1xuICAgICAgaWYgKHBvc0VxKGxhc3RQb3MsIGN1cikpIHJldHVybjtcbiAgICAgIGxhc3RQb3MgPSBjdXI7XG5cbiAgICAgIGlmICh0eXBlID09IFwic2luZ2xlXCIpIHtcbiAgICAgICAgZXh0ZW5kU2VsZWN0aW9uKGNtLmRvYywgY2xpcFBvcyhkb2MsIHN0YXJ0KSwgY3VyKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBzdGFydHN0YXJ0ID0gY2xpcFBvcyhkb2MsIHN0YXJ0c3RhcnQpO1xuICAgICAgc3RhcnRlbmQgPSBjbGlwUG9zKGRvYywgc3RhcnRlbmQpO1xuICAgICAgaWYgKHR5cGUgPT0gXCJkb3VibGVcIikge1xuICAgICAgICB2YXIgd29yZCA9IGZpbmRXb3JkQXQoZ2V0TGluZShkb2MsIGN1ci5saW5lKS50ZXh0LCBjdXIpO1xuICAgICAgICBpZiAocG9zTGVzcyhjdXIsIHN0YXJ0c3RhcnQpKSBleHRlbmRTZWxlY3Rpb24oY20uZG9jLCB3b3JkLmZyb20sIHN0YXJ0ZW5kKTtcbiAgICAgICAgZWxzZSBleHRlbmRTZWxlY3Rpb24oY20uZG9jLCBzdGFydHN0YXJ0LCB3b3JkLnRvKTtcbiAgICAgIH0gZWxzZSBpZiAodHlwZSA9PSBcInRyaXBsZVwiKSB7XG4gICAgICAgIGlmIChwb3NMZXNzKGN1ciwgc3RhcnRzdGFydCkpIGV4dGVuZFNlbGVjdGlvbihjbS5kb2MsIHN0YXJ0ZW5kLCBjbGlwUG9zKGRvYywgUG9zKGN1ci5saW5lLCAwKSkpO1xuICAgICAgICBlbHNlIGV4dGVuZFNlbGVjdGlvbihjbS5kb2MsIHN0YXJ0c3RhcnQsIGNsaXBQb3MoZG9jLCBQb3MoY3VyLmxpbmUgKyAxLCAwKSkpO1xuICAgICAgfVxuICAgIH1cblxuICAgIHZhciBlZGl0b3JTaXplID0gZ2V0UmVjdChkaXNwbGF5LndyYXBwZXIpO1xuICAgIC8vIFVzZWQgdG8gZW5zdXJlIHRpbWVvdXQgcmUtdHJpZXMgZG9uJ3QgZmlyZSB3aGVuIGFub3RoZXIgZXh0ZW5kXG4gICAgLy8gaGFwcGVuZWQgaW4gdGhlIG1lYW50aW1lIChjbGVhclRpbWVvdXQgaXNuJ3QgcmVsaWFibGUgLS0gYXRcbiAgICAvLyBsZWFzdCBvbiBDaHJvbWUsIHRoZSB0aW1lb3V0cyBzdGlsbCBoYXBwZW4gZXZlbiB3aGVuIGNsZWFyZWQsXG4gICAgLy8gaWYgdGhlIGNsZWFyIGhhcHBlbnMgYWZ0ZXIgdGhlaXIgc2NoZWR1bGVkIGZpcmluZyB0aW1lKS5cbiAgICB2YXIgY291bnRlciA9IDA7XG5cbiAgICBmdW5jdGlvbiBleHRlbmQoZSkge1xuICAgICAgdmFyIGN1ckNvdW50ID0gKytjb3VudGVyO1xuICAgICAgdmFyIGN1ciA9IHBvc0Zyb21Nb3VzZShjbSwgZSwgdHJ1ZSk7XG4gICAgICBpZiAoIWN1cikgcmV0dXJuO1xuICAgICAgaWYgKCFwb3NFcShjdXIsIGxhc3QpKSB7XG4gICAgICAgIGVuc3VyZUZvY3VzKGNtKTtcbiAgICAgICAgbGFzdCA9IGN1cjtcbiAgICAgICAgZG9TZWxlY3QoY3VyKTtcbiAgICAgICAgdmFyIHZpc2libGUgPSB2aXNpYmxlTGluZXMoZGlzcGxheSwgZG9jKTtcbiAgICAgICAgaWYgKGN1ci5saW5lID49IHZpc2libGUudG8gfHwgY3VyLmxpbmUgPCB2aXNpYmxlLmZyb20pXG4gICAgICAgICAgc2V0VGltZW91dChvcGVyYXRpb24oY20sIGZ1bmN0aW9uKCl7aWYgKGNvdW50ZXIgPT0gY3VyQ291bnQpIGV4dGVuZChlKTt9KSwgMTUwKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHZhciBvdXRzaWRlID0gZS5jbGllbnRZIDwgZWRpdG9yU2l6ZS50b3AgPyAtMjAgOiBlLmNsaWVudFkgPiBlZGl0b3JTaXplLmJvdHRvbSA/IDIwIDogMDtcbiAgICAgICAgaWYgKG91dHNpZGUpIHNldFRpbWVvdXQob3BlcmF0aW9uKGNtLCBmdW5jdGlvbigpIHtcbiAgICAgICAgICBpZiAoY291bnRlciAhPSBjdXJDb3VudCkgcmV0dXJuO1xuICAgICAgICAgIGRpc3BsYXkuc2Nyb2xsZXIuc2Nyb2xsVG9wICs9IG91dHNpZGU7XG4gICAgICAgICAgZXh0ZW5kKGUpO1xuICAgICAgICB9KSwgNTApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIGRvbmUoZSkge1xuICAgICAgY291bnRlciA9IEluZmluaXR5O1xuICAgICAgZV9wcmV2ZW50RGVmYXVsdChlKTtcbiAgICAgIGZvY3VzSW5wdXQoY20pO1xuICAgICAgb2ZmKGRvY3VtZW50LCBcIm1vdXNlbW92ZVwiLCBtb3ZlKTtcbiAgICAgIG9mZihkb2N1bWVudCwgXCJtb3VzZXVwXCIsIHVwKTtcbiAgICB9XG5cbiAgICB2YXIgbW92ZSA9IG9wZXJhdGlvbihjbSwgZnVuY3Rpb24oZSkge1xuICAgICAgaWYgKChpZSAmJiAhaWVfbHQxMCkgPyAgIWUuYnV0dG9ucyA6ICFlX2J1dHRvbihlKSkgZG9uZShlKTtcbiAgICAgIGVsc2UgZXh0ZW5kKGUpO1xuICAgIH0pO1xuICAgIHZhciB1cCA9IG9wZXJhdGlvbihjbSwgZG9uZSk7XG4gICAgb24oZG9jdW1lbnQsIFwibW91c2Vtb3ZlXCIsIG1vdmUpO1xuICAgIG9uKGRvY3VtZW50LCBcIm1vdXNldXBcIiwgdXApO1xuICB9XG5cbiAgZnVuY3Rpb24gZ3V0dGVyRXZlbnQoY20sIGUsIHR5cGUsIHByZXZlbnQsIHNpZ25hbGZuKSB7XG4gICAgdHJ5IHsgdmFyIG1YID0gZS5jbGllbnRYLCBtWSA9IGUuY2xpZW50WTsgfVxuICAgIGNhdGNoKGUpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgaWYgKG1YID49IE1hdGguZmxvb3IoZ2V0UmVjdChjbS5kaXNwbGF5Lmd1dHRlcnMpLnJpZ2h0KSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChwcmV2ZW50KSBlX3ByZXZlbnREZWZhdWx0KGUpO1xuXG4gICAgdmFyIGRpc3BsYXkgPSBjbS5kaXNwbGF5O1xuICAgIHZhciBsaW5lQm94ID0gZ2V0UmVjdChkaXNwbGF5LmxpbmVEaXYpO1xuXG4gICAgaWYgKG1ZID4gbGluZUJveC5ib3R0b20gfHwgIWhhc0hhbmRsZXIoY20sIHR5cGUpKSByZXR1cm4gZV9kZWZhdWx0UHJldmVudGVkKGUpO1xuICAgIG1ZIC09IGxpbmVCb3gudG9wIC0gZGlzcGxheS52aWV3T2Zmc2V0O1xuXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjbS5vcHRpb25zLmd1dHRlcnMubGVuZ3RoOyArK2kpIHtcbiAgICAgIHZhciBnID0gZGlzcGxheS5ndXR0ZXJzLmNoaWxkTm9kZXNbaV07XG4gICAgICBpZiAoZyAmJiBnZXRSZWN0KGcpLnJpZ2h0ID49IG1YKSB7XG4gICAgICAgIHZhciBsaW5lID0gbGluZUF0SGVpZ2h0KGNtLmRvYywgbVkpO1xuICAgICAgICB2YXIgZ3V0dGVyID0gY20ub3B0aW9ucy5ndXR0ZXJzW2ldO1xuICAgICAgICBzaWduYWxmbihjbSwgdHlwZSwgY20sIGxpbmUsIGd1dHRlciwgZSk7XG4gICAgICAgIHJldHVybiBlX2RlZmF1bHRQcmV2ZW50ZWQoZSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gY29udGV4dE1lbnVJbkd1dHRlcihjbSwgZSkge1xuICAgIGlmICghaGFzSGFuZGxlcihjbSwgXCJndXR0ZXJDb250ZXh0TWVudVwiKSkgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiBndXR0ZXJFdmVudChjbSwgZSwgXCJndXR0ZXJDb250ZXh0TWVudVwiLCBmYWxzZSwgc2lnbmFsKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNsaWNrSW5HdXR0ZXIoY20sIGUpIHtcbiAgICByZXR1cm4gZ3V0dGVyRXZlbnQoY20sIGUsIFwiZ3V0dGVyQ2xpY2tcIiwgdHJ1ZSwgc2lnbmFsTGF0ZXIpO1xuICB9XG5cbiAgLy8gS2x1ZGdlIHRvIHdvcmsgYXJvdW5kIHN0cmFuZ2UgSUUgYmVoYXZpb3Igd2hlcmUgaXQnbGwgc29tZXRpbWVzXG4gIC8vIHJlLWZpcmUgYSBzZXJpZXMgb2YgZHJhZy1yZWxhdGVkIGV2ZW50cyByaWdodCBhZnRlciB0aGUgZHJvcCAoIzE1NTEpXG4gIHZhciBsYXN0RHJvcCA9IDA7XG5cbiAgZnVuY3Rpb24gb25Ecm9wKGUpIHtcbiAgICB2YXIgY20gPSB0aGlzO1xuICAgIGlmIChzaWduYWxET01FdmVudChjbSwgZSkgfHwgZXZlbnRJbldpZGdldChjbS5kaXNwbGF5LCBlKSB8fCAoY20ub3B0aW9ucy5vbkRyYWdFdmVudCAmJiBjbS5vcHRpb25zLm9uRHJhZ0V2ZW50KGNtLCBhZGRTdG9wKGUpKSkpXG4gICAgICByZXR1cm47XG4gICAgZV9wcmV2ZW50RGVmYXVsdChlKTtcbiAgICBpZiAoaWUpIGxhc3REcm9wID0gK25ldyBEYXRlO1xuICAgIHZhciBwb3MgPSBwb3NGcm9tTW91c2UoY20sIGUsIHRydWUpLCBmaWxlcyA9IGUuZGF0YVRyYW5zZmVyLmZpbGVzO1xuICAgIGlmICghcG9zIHx8IGlzUmVhZE9ubHkoY20pKSByZXR1cm47XG4gICAgaWYgKGZpbGVzICYmIGZpbGVzLmxlbmd0aCAmJiB3aW5kb3cuRmlsZVJlYWRlciAmJiB3aW5kb3cuRmlsZSkge1xuICAgICAgdmFyIG4gPSBmaWxlcy5sZW5ndGgsIHRleHQgPSBBcnJheShuKSwgcmVhZCA9IDA7XG4gICAgICB2YXIgbG9hZEZpbGUgPSBmdW5jdGlvbihmaWxlLCBpKSB7XG4gICAgICAgIHZhciByZWFkZXIgPSBuZXcgRmlsZVJlYWRlcjtcbiAgICAgICAgcmVhZGVyLm9ubG9hZCA9IGZ1bmN0aW9uKCkge1xuICAgICAgICAgIHRleHRbaV0gPSByZWFkZXIucmVzdWx0O1xuICAgICAgICAgIGlmICgrK3JlYWQgPT0gbikge1xuICAgICAgICAgICAgcG9zID0gY2xpcFBvcyhjbS5kb2MsIHBvcyk7XG4gICAgICAgICAgICBtYWtlQ2hhbmdlKGNtLmRvYywge2Zyb206IHBvcywgdG86IHBvcywgdGV4dDogc3BsaXRMaW5lcyh0ZXh0LmpvaW4oXCJcXG5cIikpLCBvcmlnaW46IFwicGFzdGVcIn0sIFwiYXJvdW5kXCIpO1xuICAgICAgICAgIH1cbiAgICAgICAgfTtcbiAgICAgICAgcmVhZGVyLnJlYWRBc1RleHQoZmlsZSk7XG4gICAgICB9O1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBuOyArK2kpIGxvYWRGaWxlKGZpbGVzW2ldLCBpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gRG9uJ3QgZG8gYSByZXBsYWNlIGlmIHRoZSBkcm9wIGhhcHBlbmVkIGluc2lkZSBvZiB0aGUgc2VsZWN0ZWQgdGV4dC5cbiAgICAgIGlmIChjbS5zdGF0ZS5kcmFnZ2luZ1RleHQgJiYgIShwb3NMZXNzKHBvcywgY20uZG9jLnNlbC5mcm9tKSB8fCBwb3NMZXNzKGNtLmRvYy5zZWwudG8sIHBvcykpKSB7XG4gICAgICAgIGNtLnN0YXRlLmRyYWdnaW5nVGV4dChlKTtcbiAgICAgICAgLy8gRW5zdXJlIHRoZSBlZGl0b3IgaXMgcmUtZm9jdXNlZFxuICAgICAgICBzZXRUaW1lb3V0KGJpbmQoZm9jdXNJbnB1dCwgY20pLCAyMCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRyeSB7XG4gICAgICAgIHZhciB0ZXh0ID0gZS5kYXRhVHJhbnNmZXIuZ2V0RGF0YShcIlRleHRcIik7XG4gICAgICAgIGlmICh0ZXh0KSB7XG4gICAgICAgICAgdmFyIGN1ckZyb20gPSBjbS5kb2Muc2VsLmZyb20sIGN1clRvID0gY20uZG9jLnNlbC50bztcbiAgICAgICAgICBzZXRTZWxlY3Rpb24oY20uZG9jLCBwb3MsIHBvcyk7XG4gICAgICAgICAgaWYgKGNtLnN0YXRlLmRyYWdnaW5nVGV4dCkgcmVwbGFjZVJhbmdlKGNtLmRvYywgXCJcIiwgY3VyRnJvbSwgY3VyVG8sIFwicGFzdGVcIik7XG4gICAgICAgICAgY20ucmVwbGFjZVNlbGVjdGlvbih0ZXh0LCBudWxsLCBcInBhc3RlXCIpO1xuICAgICAgICAgIGZvY3VzSW5wdXQoY20pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBjYXRjaChlKXt9XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gb25EcmFnU3RhcnQoY20sIGUpIHtcbiAgICBpZiAoaWUgJiYgKCFjbS5zdGF0ZS5kcmFnZ2luZ1RleHQgfHwgK25ldyBEYXRlIC0gbGFzdERyb3AgPCAxMDApKSB7IGVfc3RvcChlKTsgcmV0dXJuOyB9XG4gICAgaWYgKHNpZ25hbERPTUV2ZW50KGNtLCBlKSB8fCBldmVudEluV2lkZ2V0KGNtLmRpc3BsYXksIGUpKSByZXR1cm47XG5cbiAgICB2YXIgdHh0ID0gY20uZ2V0U2VsZWN0aW9uKCk7XG4gICAgZS5kYXRhVHJhbnNmZXIuc2V0RGF0YShcIlRleHRcIiwgdHh0KTtcblxuICAgIC8vIFVzZSBkdW1teSBpbWFnZSBpbnN0ZWFkIG9mIGRlZmF1bHQgYnJvd3NlcnMgaW1hZ2UuXG4gICAgLy8gUmVjZW50IFNhZmFyaSAofjYuMC4yKSBoYXZlIGEgdGVuZGVuY3kgdG8gc2VnZmF1bHQgd2hlbiB0aGlzIGhhcHBlbnMsIHNvIHdlIGRvbid0IGRvIGl0IHRoZXJlLlxuICAgIGlmIChlLmRhdGFUcmFuc2Zlci5zZXREcmFnSW1hZ2UgJiYgIXNhZmFyaSkge1xuICAgICAgdmFyIGltZyA9IGVsdChcImltZ1wiLCBudWxsLCBudWxsLCBcInBvc2l0aW9uOiBmaXhlZDsgbGVmdDogMDsgdG9wOiAwO1wiKTtcbiAgICAgIGltZy5zcmMgPSBcImRhdGE6aW1hZ2UvZ2lmO2Jhc2U2NCxSMGxHT0RsaEFRQUJBQUFBQUNINUJBRUtBQUVBTEFBQUFBQUJBQUVBQUFJQ1RBRUFPdz09XCI7XG4gICAgICBpZiAob3BlcmEpIHtcbiAgICAgICAgaW1nLndpZHRoID0gaW1nLmhlaWdodCA9IDE7XG4gICAgICAgIGNtLmRpc3BsYXkud3JhcHBlci5hcHBlbmRDaGlsZChpbWcpO1xuICAgICAgICAvLyBGb3JjZSBhIHJlbGF5b3V0LCBvciBPcGVyYSB3b24ndCB1c2Ugb3VyIGltYWdlIGZvciBzb21lIG9ic2N1cmUgcmVhc29uXG4gICAgICAgIGltZy5fdG9wID0gaW1nLm9mZnNldFRvcDtcbiAgICAgIH1cbiAgICAgIGUuZGF0YVRyYW5zZmVyLnNldERyYWdJbWFnZShpbWcsIDAsIDApO1xuICAgICAgaWYgKG9wZXJhKSBpbWcucGFyZW50Tm9kZS5yZW1vdmVDaGlsZChpbWcpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHNldFNjcm9sbFRvcChjbSwgdmFsKSB7XG4gICAgaWYgKE1hdGguYWJzKGNtLmRvYy5zY3JvbGxUb3AgLSB2YWwpIDwgMikgcmV0dXJuO1xuICAgIGNtLmRvYy5zY3JvbGxUb3AgPSB2YWw7XG4gICAgaWYgKCFnZWNrbykgdXBkYXRlRGlzcGxheShjbSwgW10sIHZhbCk7XG4gICAgaWYgKGNtLmRpc3BsYXkuc2Nyb2xsZXIuc2Nyb2xsVG9wICE9IHZhbCkgY20uZGlzcGxheS5zY3JvbGxlci5zY3JvbGxUb3AgPSB2YWw7XG4gICAgaWYgKGNtLmRpc3BsYXkuc2Nyb2xsYmFyVi5zY3JvbGxUb3AgIT0gdmFsKSBjbS5kaXNwbGF5LnNjcm9sbGJhclYuc2Nyb2xsVG9wID0gdmFsO1xuICAgIGlmIChnZWNrbykgdXBkYXRlRGlzcGxheShjbSwgW10pO1xuICAgIHN0YXJ0V29ya2VyKGNtLCAxMDApO1xuICB9XG4gIGZ1bmN0aW9uIHNldFNjcm9sbExlZnQoY20sIHZhbCwgaXNTY3JvbGxlcikge1xuICAgIGlmIChpc1Njcm9sbGVyID8gdmFsID09IGNtLmRvYy5zY3JvbGxMZWZ0IDogTWF0aC5hYnMoY20uZG9jLnNjcm9sbExlZnQgLSB2YWwpIDwgMikgcmV0dXJuO1xuICAgIHZhbCA9IE1hdGgubWluKHZhbCwgY20uZGlzcGxheS5zY3JvbGxlci5zY3JvbGxXaWR0aCAtIGNtLmRpc3BsYXkuc2Nyb2xsZXIuY2xpZW50V2lkdGgpO1xuICAgIGNtLmRvYy5zY3JvbGxMZWZ0ID0gdmFsO1xuICAgIGFsaWduSG9yaXpvbnRhbGx5KGNtKTtcbiAgICBpZiAoY20uZGlzcGxheS5zY3JvbGxlci5zY3JvbGxMZWZ0ICE9IHZhbCkgY20uZGlzcGxheS5zY3JvbGxlci5zY3JvbGxMZWZ0ID0gdmFsO1xuICAgIGlmIChjbS5kaXNwbGF5LnNjcm9sbGJhckguc2Nyb2xsTGVmdCAhPSB2YWwpIGNtLmRpc3BsYXkuc2Nyb2xsYmFySC5zY3JvbGxMZWZ0ID0gdmFsO1xuICB9XG5cbiAgLy8gU2luY2UgdGhlIGRlbHRhIHZhbHVlcyByZXBvcnRlZCBvbiBtb3VzZSB3aGVlbCBldmVudHMgYXJlXG4gIC8vIHVuc3RhbmRhcmRpemVkIGJldHdlZW4gYnJvd3NlcnMgYW5kIGV2ZW4gYnJvd3NlciB2ZXJzaW9ucywgYW5kXG4gIC8vIGdlbmVyYWxseSBob3JyaWJseSB1bnByZWRpY3RhYmxlLCB0aGlzIGNvZGUgc3RhcnRzIGJ5IG1lYXN1cmluZ1xuICAvLyB0aGUgc2Nyb2xsIGVmZmVjdCB0aGF0IHRoZSBmaXJzdCBmZXcgbW91c2Ugd2hlZWwgZXZlbnRzIGhhdmUsXG4gIC8vIGFuZCwgZnJvbSB0aGF0LCBkZXRlY3RzIHRoZSB3YXkgaXQgY2FuIGNvbnZlcnQgZGVsdGFzIHRvIHBpeGVsXG4gIC8vIG9mZnNldHMgYWZ0ZXJ3YXJkcy5cbiAgLy9cbiAgLy8gVGhlIHJlYXNvbiB3ZSB3YW50IHRvIGtub3cgdGhlIGFtb3VudCBhIHdoZWVsIGV2ZW50IHdpbGwgc2Nyb2xsXG4gIC8vIGlzIHRoYXQgaXQgZ2l2ZXMgdXMgYSBjaGFuY2UgdG8gdXBkYXRlIHRoZSBkaXNwbGF5IGJlZm9yZSB0aGVcbiAgLy8gYWN0dWFsIHNjcm9sbGluZyBoYXBwZW5zLCByZWR1Y2luZyBmbGlja2VyaW5nLlxuXG4gIHZhciB3aGVlbFNhbXBsZXMgPSAwLCB3aGVlbFBpeGVsc1BlclVuaXQgPSBudWxsO1xuICAvLyBGaWxsIGluIGEgYnJvd3Nlci1kZXRlY3RlZCBzdGFydGluZyB2YWx1ZSBvbiBicm93c2VycyB3aGVyZSB3ZVxuICAvLyBrbm93IG9uZS4gVGhlc2UgZG9uJ3QgaGF2ZSB0byBiZSBhY2N1cmF0ZSAtLSB0aGUgcmVzdWx0IG9mIHRoZW1cbiAgLy8gYmVpbmcgd3Jvbmcgd291bGQganVzdCBiZSBhIHNsaWdodCBmbGlja2VyIG9uIHRoZSBmaXJzdCB3aGVlbFxuICAvLyBzY3JvbGwgKGlmIGl0IGlzIGxhcmdlIGVub3VnaCkuXG4gIGlmIChpZSkgd2hlZWxQaXhlbHNQZXJVbml0ID0gLS41MztcbiAgZWxzZSBpZiAoZ2Vja28pIHdoZWVsUGl4ZWxzUGVyVW5pdCA9IDE1O1xuICBlbHNlIGlmIChjaHJvbWUpIHdoZWVsUGl4ZWxzUGVyVW5pdCA9IC0uNztcbiAgZWxzZSBpZiAoc2FmYXJpKSB3aGVlbFBpeGVsc1BlclVuaXQgPSAtMS8zO1xuXG4gIGZ1bmN0aW9uIG9uU2Nyb2xsV2hlZWwoY20sIGUpIHtcbiAgICB2YXIgZHggPSBlLndoZWVsRGVsdGFYLCBkeSA9IGUud2hlZWxEZWx0YVk7XG4gICAgaWYgKGR4ID09IG51bGwgJiYgZS5kZXRhaWwgJiYgZS5heGlzID09IGUuSE9SSVpPTlRBTF9BWElTKSBkeCA9IGUuZGV0YWlsO1xuICAgIGlmIChkeSA9PSBudWxsICYmIGUuZGV0YWlsICYmIGUuYXhpcyA9PSBlLlZFUlRJQ0FMX0FYSVMpIGR5ID0gZS5kZXRhaWw7XG4gICAgZWxzZSBpZiAoZHkgPT0gbnVsbCkgZHkgPSBlLndoZWVsRGVsdGE7XG5cbiAgICB2YXIgZGlzcGxheSA9IGNtLmRpc3BsYXksIHNjcm9sbCA9IGRpc3BsYXkuc2Nyb2xsZXI7XG4gICAgLy8gUXVpdCBpZiB0aGVyZSdzIG5vdGhpbmcgdG8gc2Nyb2xsIGhlcmVcbiAgICBpZiAoIShkeCAmJiBzY3JvbGwuc2Nyb2xsV2lkdGggPiBzY3JvbGwuY2xpZW50V2lkdGggfHxcbiAgICAgICAgICBkeSAmJiBzY3JvbGwuc2Nyb2xsSGVpZ2h0ID4gc2Nyb2xsLmNsaWVudEhlaWdodCkpIHJldHVybjtcblxuICAgIC8vIFdlYmtpdCBicm93c2VycyBvbiBPUyBYIGFib3J0IG1vbWVudHVtIHNjcm9sbHMgd2hlbiB0aGUgdGFyZ2V0XG4gICAgLy8gb2YgdGhlIHNjcm9sbCBldmVudCBpcyByZW1vdmVkIGZyb20gdGhlIHNjcm9sbGFibGUgZWxlbWVudC5cbiAgICAvLyBUaGlzIGhhY2sgKHNlZSByZWxhdGVkIGNvZGUgaW4gcGF0Y2hEaXNwbGF5KSBtYWtlcyBzdXJlIHRoZVxuICAgIC8vIGVsZW1lbnQgaXMga2VwdCBhcm91bmQuXG4gICAgaWYgKGR5ICYmIG1hYyAmJiB3ZWJraXQpIHtcbiAgICAgIGZvciAodmFyIGN1ciA9IGUudGFyZ2V0OyBjdXIgIT0gc2Nyb2xsOyBjdXIgPSBjdXIucGFyZW50Tm9kZSkge1xuICAgICAgICBpZiAoY3VyLmxpbmVPYmopIHtcbiAgICAgICAgICBjbS5kaXNwbGF5LmN1cnJlbnRXaGVlbFRhcmdldCA9IGN1cjtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIC8vIE9uIHNvbWUgYnJvd3NlcnMsIGhvcml6b250YWwgc2Nyb2xsaW5nIHdpbGwgY2F1c2UgcmVkcmF3cyB0b1xuICAgIC8vIGhhcHBlbiBiZWZvcmUgdGhlIGd1dHRlciBoYXMgYmVlbiByZWFsaWduZWQsIGNhdXNpbmcgaXQgdG9cbiAgICAvLyB3cmlnZ2xlIGFyb3VuZCBpbiBhIG1vc3QgdW5zZWVtbHkgd2F5LiBXaGVuIHdlIGhhdmUgYW5cbiAgICAvLyBlc3RpbWF0ZWQgcGl4ZWxzL2RlbHRhIHZhbHVlLCB3ZSBqdXN0IGhhbmRsZSBob3Jpem9udGFsXG4gICAgLy8gc2Nyb2xsaW5nIGVudGlyZWx5IGhlcmUuIEl0J2xsIGJlIHNsaWdodGx5IG9mZiBmcm9tIG5hdGl2ZSwgYnV0XG4gICAgLy8gYmV0dGVyIHRoYW4gZ2xpdGNoaW5nIG91dC5cbiAgICBpZiAoZHggJiYgIWdlY2tvICYmICFvcGVyYSAmJiB3aGVlbFBpeGVsc1BlclVuaXQgIT0gbnVsbCkge1xuICAgICAgaWYgKGR5KVxuICAgICAgICBzZXRTY3JvbGxUb3AoY20sIE1hdGgubWF4KDAsIE1hdGgubWluKHNjcm9sbC5zY3JvbGxUb3AgKyBkeSAqIHdoZWVsUGl4ZWxzUGVyVW5pdCwgc2Nyb2xsLnNjcm9sbEhlaWdodCAtIHNjcm9sbC5jbGllbnRIZWlnaHQpKSk7XG4gICAgICBzZXRTY3JvbGxMZWZ0KGNtLCBNYXRoLm1heCgwLCBNYXRoLm1pbihzY3JvbGwuc2Nyb2xsTGVmdCArIGR4ICogd2hlZWxQaXhlbHNQZXJVbml0LCBzY3JvbGwuc2Nyb2xsV2lkdGggLSBzY3JvbGwuY2xpZW50V2lkdGgpKSk7XG4gICAgICBlX3ByZXZlbnREZWZhdWx0KGUpO1xuICAgICAgZGlzcGxheS53aGVlbFN0YXJ0WCA9IG51bGw7IC8vIEFib3J0IG1lYXN1cmVtZW50LCBpZiBpbiBwcm9ncmVzc1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChkeSAmJiB3aGVlbFBpeGVsc1BlclVuaXQgIT0gbnVsbCkge1xuICAgICAgdmFyIHBpeGVscyA9IGR5ICogd2hlZWxQaXhlbHNQZXJVbml0O1xuICAgICAgdmFyIHRvcCA9IGNtLmRvYy5zY3JvbGxUb3AsIGJvdCA9IHRvcCArIGRpc3BsYXkud3JhcHBlci5jbGllbnRIZWlnaHQ7XG4gICAgICBpZiAocGl4ZWxzIDwgMCkgdG9wID0gTWF0aC5tYXgoMCwgdG9wICsgcGl4ZWxzIC0gNTApO1xuICAgICAgZWxzZSBib3QgPSBNYXRoLm1pbihjbS5kb2MuaGVpZ2h0LCBib3QgKyBwaXhlbHMgKyA1MCk7XG4gICAgICB1cGRhdGVEaXNwbGF5KGNtLCBbXSwge3RvcDogdG9wLCBib3R0b206IGJvdH0pO1xuICAgIH1cblxuICAgIGlmICh3aGVlbFNhbXBsZXMgPCAyMCkge1xuICAgICAgaWYgKGRpc3BsYXkud2hlZWxTdGFydFggPT0gbnVsbCkge1xuICAgICAgICBkaXNwbGF5LndoZWVsU3RhcnRYID0gc2Nyb2xsLnNjcm9sbExlZnQ7IGRpc3BsYXkud2hlZWxTdGFydFkgPSBzY3JvbGwuc2Nyb2xsVG9wO1xuICAgICAgICBkaXNwbGF5LndoZWVsRFggPSBkeDsgZGlzcGxheS53aGVlbERZID0gZHk7XG4gICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgICAgICAgaWYgKGRpc3BsYXkud2hlZWxTdGFydFggPT0gbnVsbCkgcmV0dXJuO1xuICAgICAgICAgIHZhciBtb3ZlZFggPSBzY3JvbGwuc2Nyb2xsTGVmdCAtIGRpc3BsYXkud2hlZWxTdGFydFg7XG4gICAgICAgICAgdmFyIG1vdmVkWSA9IHNjcm9sbC5zY3JvbGxUb3AgLSBkaXNwbGF5LndoZWVsU3RhcnRZO1xuICAgICAgICAgIHZhciBzYW1wbGUgPSAobW92ZWRZICYmIGRpc3BsYXkud2hlZWxEWSAmJiBtb3ZlZFkgLyBkaXNwbGF5LndoZWVsRFkpIHx8XG4gICAgICAgICAgICAobW92ZWRYICYmIGRpc3BsYXkud2hlZWxEWCAmJiBtb3ZlZFggLyBkaXNwbGF5LndoZWVsRFgpO1xuICAgICAgICAgIGRpc3BsYXkud2hlZWxTdGFydFggPSBkaXNwbGF5LndoZWVsU3RhcnRZID0gbnVsbDtcbiAgICAgICAgICBpZiAoIXNhbXBsZSkgcmV0dXJuO1xuICAgICAgICAgIHdoZWVsUGl4ZWxzUGVyVW5pdCA9ICh3aGVlbFBpeGVsc1BlclVuaXQgKiB3aGVlbFNhbXBsZXMgKyBzYW1wbGUpIC8gKHdoZWVsU2FtcGxlcyArIDEpO1xuICAgICAgICAgICsrd2hlZWxTYW1wbGVzO1xuICAgICAgICB9LCAyMDApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZGlzcGxheS53aGVlbERYICs9IGR4OyBkaXNwbGF5LndoZWVsRFkgKz0gZHk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gZG9IYW5kbGVCaW5kaW5nKGNtLCBib3VuZCwgZHJvcFNoaWZ0KSB7XG4gICAgaWYgKHR5cGVvZiBib3VuZCA9PSBcInN0cmluZ1wiKSB7XG4gICAgICBib3VuZCA9IGNvbW1hbmRzW2JvdW5kXTtcbiAgICAgIGlmICghYm91bmQpIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgLy8gRW5zdXJlIHByZXZpb3VzIGlucHV0IGhhcyBiZWVuIHJlYWQsIHNvIHRoYXQgdGhlIGhhbmRsZXIgc2VlcyBhXG4gICAgLy8gY29uc2lzdGVudCB2aWV3IG9mIHRoZSBkb2N1bWVudFxuICAgIGlmIChjbS5kaXNwbGF5LnBvbGxpbmdGYXN0ICYmIHJlYWRJbnB1dChjbSkpIGNtLmRpc3BsYXkucG9sbGluZ0Zhc3QgPSBmYWxzZTtcbiAgICB2YXIgZG9jID0gY20uZG9jLCBwcmV2U2hpZnQgPSBkb2Muc2VsLnNoaWZ0LCBkb25lID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGlmIChpc1JlYWRPbmx5KGNtKSkgY20uc3RhdGUuc3VwcHJlc3NFZGl0cyA9IHRydWU7XG4gICAgICBpZiAoZHJvcFNoaWZ0KSBkb2Muc2VsLnNoaWZ0ID0gZmFsc2U7XG4gICAgICBkb25lID0gYm91bmQoY20pICE9IFBhc3M7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGRvYy5zZWwuc2hpZnQgPSBwcmV2U2hpZnQ7XG4gICAgICBjbS5zdGF0ZS5zdXBwcmVzc0VkaXRzID0gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiBkb25lO1xuICB9XG5cbiAgZnVuY3Rpb24gYWxsS2V5TWFwcyhjbSkge1xuICAgIHZhciBtYXBzID0gY20uc3RhdGUua2V5TWFwcy5zbGljZSgwKTtcbiAgICBpZiAoY20ub3B0aW9ucy5leHRyYUtleXMpIG1hcHMucHVzaChjbS5vcHRpb25zLmV4dHJhS2V5cyk7XG4gICAgbWFwcy5wdXNoKGNtLm9wdGlvbnMua2V5TWFwKTtcbiAgICByZXR1cm4gbWFwcztcbiAgfVxuXG4gIHZhciBtYXliZVRyYW5zaXRpb247XG4gIGZ1bmN0aW9uIGhhbmRsZUtleUJpbmRpbmcoY20sIGUpIHtcbiAgICAvLyBIYW5kbGUgYXV0byBrZXltYXAgdHJhbnNpdGlvbnNcbiAgICB2YXIgc3RhcnRNYXAgPSBnZXRLZXlNYXAoY20ub3B0aW9ucy5rZXlNYXApLCBuZXh0ID0gc3RhcnRNYXAuYXV0bztcbiAgICBjbGVhclRpbWVvdXQobWF5YmVUcmFuc2l0aW9uKTtcbiAgICBpZiAobmV4dCAmJiAhaXNNb2RpZmllcktleShlKSkgbWF5YmVUcmFuc2l0aW9uID0gc2V0VGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgIGlmIChnZXRLZXlNYXAoY20ub3B0aW9ucy5rZXlNYXApID09IHN0YXJ0TWFwKSB7XG4gICAgICAgIGNtLm9wdGlvbnMua2V5TWFwID0gKG5leHQuY2FsbCA/IG5leHQuY2FsbChudWxsLCBjbSkgOiBuZXh0KTtcbiAgICAgICAga2V5TWFwQ2hhbmdlZChjbSk7XG4gICAgICB9XG4gICAgfSwgNTApO1xuXG4gICAgdmFyIG5hbWUgPSBrZXlOYW1lKGUsIHRydWUpLCBoYW5kbGVkID0gZmFsc2U7XG4gICAgaWYgKCFuYW1lKSByZXR1cm4gZmFsc2U7XG4gICAgdmFyIGtleW1hcHMgPSBhbGxLZXlNYXBzKGNtKTtcblxuICAgIGlmIChlLnNoaWZ0S2V5KSB7XG4gICAgICAvLyBGaXJzdCB0cnkgdG8gcmVzb2x2ZSBmdWxsIG5hbWUgKGluY2x1ZGluZyAnU2hpZnQtJykuIEZhaWxpbmdcbiAgICAgIC8vIHRoYXQsIHNlZSBpZiB0aGVyZSBpcyBhIGN1cnNvci1tb3Rpb24gY29tbWFuZCAoc3RhcnRpbmcgd2l0aFxuICAgICAgLy8gJ2dvJykgYm91bmQgdG8gdGhlIGtleW5hbWUgd2l0aG91dCAnU2hpZnQtJy5cbiAgICAgIGhhbmRsZWQgPSBsb29rdXBLZXkoXCJTaGlmdC1cIiArIG5hbWUsIGtleW1hcHMsIGZ1bmN0aW9uKGIpIHtyZXR1cm4gZG9IYW5kbGVCaW5kaW5nKGNtLCBiLCB0cnVlKTt9KVxuICAgICAgICAgICAgIHx8IGxvb2t1cEtleShuYW1lLCBrZXltYXBzLCBmdW5jdGlvbihiKSB7XG4gICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGIgPT0gXCJzdHJpbmdcIiA/IC9eZ29bQS1aXS8udGVzdChiKSA6IGIubW90aW9uKVxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZG9IYW5kbGVCaW5kaW5nKGNtLCBiKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgaGFuZGxlZCA9IGxvb2t1cEtleShuYW1lLCBrZXltYXBzLCBmdW5jdGlvbihiKSB7IHJldHVybiBkb0hhbmRsZUJpbmRpbmcoY20sIGIpOyB9KTtcbiAgICB9XG5cbiAgICBpZiAoaGFuZGxlZCkge1xuICAgICAgZV9wcmV2ZW50RGVmYXVsdChlKTtcbiAgICAgIHJlc3RhcnRCbGluayhjbSk7XG4gICAgICBpZiAoaWVfbHQ5KSB7IGUub2xkS2V5Q29kZSA9IGUua2V5Q29kZTsgZS5rZXlDb2RlID0gMDsgfVxuICAgICAgc2lnbmFsTGF0ZXIoY20sIFwia2V5SGFuZGxlZFwiLCBjbSwgbmFtZSwgZSk7XG4gICAgfVxuICAgIHJldHVybiBoYW5kbGVkO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlQ2hhckJpbmRpbmcoY20sIGUsIGNoKSB7XG4gICAgdmFyIGhhbmRsZWQgPSBsb29rdXBLZXkoXCInXCIgKyBjaCArIFwiJ1wiLCBhbGxLZXlNYXBzKGNtKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmdW5jdGlvbihiKSB7IHJldHVybiBkb0hhbmRsZUJpbmRpbmcoY20sIGIsIHRydWUpOyB9KTtcbiAgICBpZiAoaGFuZGxlZCkge1xuICAgICAgZV9wcmV2ZW50RGVmYXVsdChlKTtcbiAgICAgIHJlc3RhcnRCbGluayhjbSk7XG4gICAgICBzaWduYWxMYXRlcihjbSwgXCJrZXlIYW5kbGVkXCIsIGNtLCBcIidcIiArIGNoICsgXCInXCIsIGUpO1xuICAgIH1cbiAgICByZXR1cm4gaGFuZGxlZDtcbiAgfVxuXG4gIGZ1bmN0aW9uIG9uS2V5VXAoZSkge1xuICAgIHZhciBjbSA9IHRoaXM7XG4gICAgaWYgKHNpZ25hbERPTUV2ZW50KGNtLCBlKSB8fCBjbS5vcHRpb25zLm9uS2V5RXZlbnQgJiYgY20ub3B0aW9ucy5vbktleUV2ZW50KGNtLCBhZGRTdG9wKGUpKSkgcmV0dXJuO1xuICAgIGlmIChlLmtleUNvZGUgPT0gMTYpIGNtLmRvYy5zZWwuc2hpZnQgPSBmYWxzZTtcbiAgfVxuXG4gIHZhciBsYXN0U3RvcHBlZEtleSA9IG51bGw7XG4gIGZ1bmN0aW9uIG9uS2V5RG93bihlKSB7XG4gICAgdmFyIGNtID0gdGhpcztcbiAgICBlbnN1cmVGb2N1cyhjbSk7XG4gICAgaWYgKHNpZ25hbERPTUV2ZW50KGNtLCBlKSB8fCBjbS5vcHRpb25zLm9uS2V5RXZlbnQgJiYgY20ub3B0aW9ucy5vbktleUV2ZW50KGNtLCBhZGRTdG9wKGUpKSkgcmV0dXJuO1xuICAgIGlmIChvbGRfaWUgJiYgZS5rZXlDb2RlID09IDI3KSBlLnJldHVyblZhbHVlID0gZmFsc2U7XG4gICAgdmFyIGNvZGUgPSBlLmtleUNvZGU7XG4gICAgLy8gSUUgZG9lcyBzdHJhbmdlIHRoaW5ncyB3aXRoIGVzY2FwZS5cbiAgICBjbS5kb2Muc2VsLnNoaWZ0ID0gY29kZSA9PSAxNiB8fCBlLnNoaWZ0S2V5O1xuICAgIC8vIEZpcnN0IGdpdmUgb25LZXlFdmVudCBvcHRpb24gYSBjaGFuY2UgdG8gaGFuZGxlIHRoaXMuXG4gICAgdmFyIGhhbmRsZWQgPSBoYW5kbGVLZXlCaW5kaW5nKGNtLCBlKTtcbiAgICBpZiAob3BlcmEpIHtcbiAgICAgIGxhc3RTdG9wcGVkS2V5ID0gaGFuZGxlZCA/IGNvZGUgOiBudWxsO1xuICAgICAgLy8gT3BlcmEgaGFzIG5vIGN1dCBldmVudC4uLiB3ZSB0cnkgdG8gYXQgbGVhc3QgY2F0Y2ggdGhlIGtleSBjb21ib1xuICAgICAgaWYgKCFoYW5kbGVkICYmIGNvZGUgPT0gODggJiYgIWhhc0NvcHlFdmVudCAmJiAobWFjID8gZS5tZXRhS2V5IDogZS5jdHJsS2V5KSlcbiAgICAgICAgY20ucmVwbGFjZVNlbGVjdGlvbihcIlwiKTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBvbktleVByZXNzKGUpIHtcbiAgICB2YXIgY20gPSB0aGlzO1xuICAgIGlmIChzaWduYWxET01FdmVudChjbSwgZSkgfHwgY20ub3B0aW9ucy5vbktleUV2ZW50ICYmIGNtLm9wdGlvbnMub25LZXlFdmVudChjbSwgYWRkU3RvcChlKSkpIHJldHVybjtcbiAgICB2YXIga2V5Q29kZSA9IGUua2V5Q29kZSwgY2hhckNvZGUgPSBlLmNoYXJDb2RlO1xuICAgIGlmIChvcGVyYSAmJiBrZXlDb2RlID09IGxhc3RTdG9wcGVkS2V5KSB7bGFzdFN0b3BwZWRLZXkgPSBudWxsOyBlX3ByZXZlbnREZWZhdWx0KGUpOyByZXR1cm47fVxuICAgIGlmICgoKG9wZXJhICYmICghZS53aGljaCB8fCBlLndoaWNoIDwgMTApKSB8fCBraHRtbCkgJiYgaGFuZGxlS2V5QmluZGluZyhjbSwgZSkpIHJldHVybjtcbiAgICB2YXIgY2ggPSBTdHJpbmcuZnJvbUNoYXJDb2RlKGNoYXJDb2RlID09IG51bGwgPyBrZXlDb2RlIDogY2hhckNvZGUpO1xuICAgIGlmIChoYW5kbGVDaGFyQmluZGluZyhjbSwgZSwgY2gpKSByZXR1cm47XG4gICAgaWYgKGllICYmICFpZV9sdDkpIGNtLmRpc3BsYXkuaW5wdXRIYXNTZWxlY3Rpb24gPSBudWxsO1xuICAgIGZhc3RQb2xsKGNtKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIG9uRm9jdXMoY20pIHtcbiAgICBpZiAoY20ub3B0aW9ucy5yZWFkT25seSA9PSBcIm5vY3Vyc29yXCIpIHJldHVybjtcbiAgICBpZiAoIWNtLnN0YXRlLmZvY3VzZWQpIHtcbiAgICAgIHNpZ25hbChjbSwgXCJmb2N1c1wiLCBjbSk7XG4gICAgICBjbS5zdGF0ZS5mb2N1c2VkID0gdHJ1ZTtcbiAgICAgIGlmIChjbS5kaXNwbGF5LndyYXBwZXIuY2xhc3NOYW1lLnNlYXJjaCgvXFxiQ29kZU1pcnJvci1mb2N1c2VkXFxiLykgPT0gLTEpXG4gICAgICAgIGNtLmRpc3BsYXkud3JhcHBlci5jbGFzc05hbWUgKz0gXCIgQ29kZU1pcnJvci1mb2N1c2VkXCI7XG4gICAgICBpZiAoIWNtLmN1ck9wKSB7XG4gICAgICAgIHJlc2V0SW5wdXQoY20sIHRydWUpO1xuICAgICAgICBpZiAod2Via2l0KSBzZXRUaW1lb3V0KGJpbmQocmVzZXRJbnB1dCwgY20sIHRydWUpLCAwKTsgLy8gSXNzdWUgIzE3MzBcbiAgICAgIH1cbiAgICB9XG4gICAgc2xvd1BvbGwoY20pO1xuICAgIHJlc3RhcnRCbGluayhjbSk7XG4gIH1cbiAgZnVuY3Rpb24gb25CbHVyKGNtKSB7XG4gICAgaWYgKGNtLnN0YXRlLmZvY3VzZWQpIHtcbiAgICAgIHNpZ25hbChjbSwgXCJibHVyXCIsIGNtKTtcbiAgICAgIGNtLnN0YXRlLmZvY3VzZWQgPSBmYWxzZTtcbiAgICAgIGNtLmRpc3BsYXkud3JhcHBlci5jbGFzc05hbWUgPSBjbS5kaXNwbGF5LndyYXBwZXIuY2xhc3NOYW1lLnJlcGxhY2UoXCIgQ29kZU1pcnJvci1mb2N1c2VkXCIsIFwiXCIpO1xuICAgIH1cbiAgICBjbGVhckludGVydmFsKGNtLmRpc3BsYXkuYmxpbmtlcik7XG4gICAgc2V0VGltZW91dChmdW5jdGlvbigpIHtpZiAoIWNtLnN0YXRlLmZvY3VzZWQpIGNtLmRvYy5zZWwuc2hpZnQgPSBmYWxzZTt9LCAxNTApO1xuICB9XG5cbiAgdmFyIGRldGVjdGluZ1NlbGVjdEFsbDtcbiAgZnVuY3Rpb24gb25Db250ZXh0TWVudShjbSwgZSkge1xuICAgIGlmIChzaWduYWxET01FdmVudChjbSwgZSwgXCJjb250ZXh0bWVudVwiKSkgcmV0dXJuO1xuICAgIHZhciBkaXNwbGF5ID0gY20uZGlzcGxheSwgc2VsID0gY20uZG9jLnNlbDtcbiAgICBpZiAoZXZlbnRJbldpZGdldChkaXNwbGF5LCBlKSB8fCBjb250ZXh0TWVudUluR3V0dGVyKGNtLCBlKSkgcmV0dXJuO1xuXG4gICAgdmFyIHBvcyA9IHBvc0Zyb21Nb3VzZShjbSwgZSksIHNjcm9sbFBvcyA9IGRpc3BsYXkuc2Nyb2xsZXIuc2Nyb2xsVG9wO1xuICAgIGlmICghcG9zIHx8IG9wZXJhKSByZXR1cm47IC8vIE9wZXJhIGlzIGRpZmZpY3VsdC5cblxuICAgIC8vIFJlc2V0IHRoZSBjdXJyZW50IHRleHQgc2VsZWN0aW9uIG9ubHkgaWYgdGhlIGNsaWNrIGlzIGRvbmUgb3V0c2lkZSBvZiB0aGUgc2VsZWN0aW9uXG4gICAgLy8gYW5kICdyZXNldFNlbGVjdGlvbk9uQ29udGV4dE1lbnUnIG9wdGlvbiBpcyB0cnVlLlxuICAgIHZhciByZXNldCA9IGNtLm9wdGlvbnMucmVzZXRTZWxlY3Rpb25PbkNvbnRleHRNZW51O1xuICAgIGlmIChyZXNldCAmJiAocG9zRXEoc2VsLmZyb20sIHNlbC50bykgfHwgcG9zTGVzcyhwb3MsIHNlbC5mcm9tKSB8fCAhcG9zTGVzcyhwb3MsIHNlbC50bykpKVxuICAgICAgb3BlcmF0aW9uKGNtLCBzZXRTZWxlY3Rpb24pKGNtLmRvYywgcG9zLCBwb3MpO1xuXG4gICAgdmFyIG9sZENTUyA9IGRpc3BsYXkuaW5wdXQuc3R5bGUuY3NzVGV4dDtcbiAgICBkaXNwbGF5LmlucHV0RGl2LnN0eWxlLnBvc2l0aW9uID0gXCJhYnNvbHV0ZVwiO1xuICAgIGRpc3BsYXkuaW5wdXQuc3R5bGUuY3NzVGV4dCA9IFwicG9zaXRpb246IGZpeGVkOyB3aWR0aDogMzBweDsgaGVpZ2h0OiAzMHB4OyB0b3A6IFwiICsgKGUuY2xpZW50WSAtIDUpICtcbiAgICAgIFwicHg7IGxlZnQ6IFwiICsgKGUuY2xpZW50WCAtIDUpICsgXCJweDsgei1pbmRleDogMTAwMDsgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7IG91dGxpbmU6IG5vbmU7XCIgK1xuICAgICAgXCJib3JkZXItd2lkdGg6IDA7IG91dGxpbmU6IG5vbmU7IG92ZXJmbG93OiBoaWRkZW47IG9wYWNpdHk6IC4wNTsgLW1zLW9wYWNpdHk6IC4wNTsgZmlsdGVyOiBhbHBoYShvcGFjaXR5PTUpO1wiO1xuICAgIGZvY3VzSW5wdXQoY20pO1xuICAgIHJlc2V0SW5wdXQoY20sIHRydWUpO1xuICAgIC8vIEFkZHMgXCJTZWxlY3QgYWxsXCIgdG8gY29udGV4dCBtZW51IGluIEZGXG4gICAgaWYgKHBvc0VxKHNlbC5mcm9tLCBzZWwudG8pKSBkaXNwbGF5LmlucHV0LnZhbHVlID0gZGlzcGxheS5wcmV2SW5wdXQgPSBcIiBcIjtcblxuICAgIGZ1bmN0aW9uIHByZXBhcmVTZWxlY3RBbGxIYWNrKCkge1xuICAgICAgaWYgKGRpc3BsYXkuaW5wdXQuc2VsZWN0aW9uU3RhcnQgIT0gbnVsbCkge1xuICAgICAgICB2YXIgZXh0dmFsID0gZGlzcGxheS5pbnB1dC52YWx1ZSA9IFwiXFx1MjAwYlwiICsgKHBvc0VxKHNlbC5mcm9tLCBzZWwudG8pID8gXCJcIiA6IGRpc3BsYXkuaW5wdXQudmFsdWUpO1xuICAgICAgICBkaXNwbGF5LnByZXZJbnB1dCA9IFwiXFx1MjAwYlwiO1xuICAgICAgICBkaXNwbGF5LmlucHV0LnNlbGVjdGlvblN0YXJ0ID0gMTsgZGlzcGxheS5pbnB1dC5zZWxlY3Rpb25FbmQgPSBleHR2YWwubGVuZ3RoO1xuICAgICAgfVxuICAgIH1cbiAgICBmdW5jdGlvbiByZWhpZGUoKSB7XG4gICAgICBkaXNwbGF5LmlucHV0RGl2LnN0eWxlLnBvc2l0aW9uID0gXCJyZWxhdGl2ZVwiO1xuICAgICAgZGlzcGxheS5pbnB1dC5zdHlsZS5jc3NUZXh0ID0gb2xkQ1NTO1xuICAgICAgaWYgKGllX2x0OSkgZGlzcGxheS5zY3JvbGxiYXJWLnNjcm9sbFRvcCA9IGRpc3BsYXkuc2Nyb2xsZXIuc2Nyb2xsVG9wID0gc2Nyb2xsUG9zO1xuICAgICAgc2xvd1BvbGwoY20pO1xuXG4gICAgICAvLyBUcnkgdG8gZGV0ZWN0IHRoZSB1c2VyIGNob29zaW5nIHNlbGVjdC1hbGxcbiAgICAgIGlmIChkaXNwbGF5LmlucHV0LnNlbGVjdGlvblN0YXJ0ICE9IG51bGwpIHtcbiAgICAgICAgaWYgKCFpZSB8fCBpZV9sdDkpIHByZXBhcmVTZWxlY3RBbGxIYWNrKCk7XG4gICAgICAgIGNsZWFyVGltZW91dChkZXRlY3RpbmdTZWxlY3RBbGwpO1xuICAgICAgICB2YXIgaSA9IDAsIHBvbGwgPSBmdW5jdGlvbigpe1xuICAgICAgICAgIGlmIChkaXNwbGF5LnByZXZJbnB1dCA9PSBcIlxcdTIwMGJcIiAmJiBkaXNwbGF5LmlucHV0LnNlbGVjdGlvblN0YXJ0ID09IDApXG4gICAgICAgICAgICBvcGVyYXRpb24oY20sIGNvbW1hbmRzLnNlbGVjdEFsbCkoY20pO1xuICAgICAgICAgIGVsc2UgaWYgKGkrKyA8IDEwKSBkZXRlY3RpbmdTZWxlY3RBbGwgPSBzZXRUaW1lb3V0KHBvbGwsIDUwMCk7XG4gICAgICAgICAgZWxzZSByZXNldElucHV0KGNtKTtcbiAgICAgICAgfTtcbiAgICAgICAgZGV0ZWN0aW5nU2VsZWN0QWxsID0gc2V0VGltZW91dChwb2xsLCAyMDApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChpZSAmJiAhaWVfbHQ5KSBwcmVwYXJlU2VsZWN0QWxsSGFjaygpO1xuICAgIGlmIChjYXB0dXJlTWlkZGxlQ2xpY2spIHtcbiAgICAgIGVfc3RvcChlKTtcbiAgICAgIHZhciBtb3VzZXVwID0gZnVuY3Rpb24oKSB7XG4gICAgICAgIG9mZih3aW5kb3csIFwibW91c2V1cFwiLCBtb3VzZXVwKTtcbiAgICAgICAgc2V0VGltZW91dChyZWhpZGUsIDIwKTtcbiAgICAgIH07XG4gICAgICBvbih3aW5kb3csIFwibW91c2V1cFwiLCBtb3VzZXVwKTtcbiAgICB9IGVsc2Uge1xuICAgICAgc2V0VGltZW91dChyZWhpZGUsIDUwKTtcbiAgICB9XG4gIH1cblxuICAvLyBVUERBVElOR1xuXG4gIHZhciBjaGFuZ2VFbmQgPSBDb2RlTWlycm9yLmNoYW5nZUVuZCA9IGZ1bmN0aW9uKGNoYW5nZSkge1xuICAgIGlmICghY2hhbmdlLnRleHQpIHJldHVybiBjaGFuZ2UudG87XG4gICAgcmV0dXJuIFBvcyhjaGFuZ2UuZnJvbS5saW5lICsgY2hhbmdlLnRleHQubGVuZ3RoIC0gMSxcbiAgICAgICAgICAgICAgIGxzdChjaGFuZ2UudGV4dCkubGVuZ3RoICsgKGNoYW5nZS50ZXh0Lmxlbmd0aCA9PSAxID8gY2hhbmdlLmZyb20uY2ggOiAwKSk7XG4gIH07XG5cbiAgLy8gTWFrZSBzdXJlIGEgcG9zaXRpb24gd2lsbCBiZSB2YWxpZCBhZnRlciB0aGUgZ2l2ZW4gY2hhbmdlLlxuICBmdW5jdGlvbiBjbGlwUG9zdENoYW5nZShkb2MsIGNoYW5nZSwgcG9zKSB7XG4gICAgaWYgKCFwb3NMZXNzKGNoYW5nZS5mcm9tLCBwb3MpKSByZXR1cm4gY2xpcFBvcyhkb2MsIHBvcyk7XG4gICAgdmFyIGRpZmYgPSAoY2hhbmdlLnRleHQubGVuZ3RoIC0gMSkgLSAoY2hhbmdlLnRvLmxpbmUgLSBjaGFuZ2UuZnJvbS5saW5lKTtcbiAgICBpZiAocG9zLmxpbmUgPiBjaGFuZ2UudG8ubGluZSArIGRpZmYpIHtcbiAgICAgIHZhciBwcmVMaW5lID0gcG9zLmxpbmUgLSBkaWZmLCBsYXN0TGluZSA9IGRvYy5maXJzdCArIGRvYy5zaXplIC0gMTtcbiAgICAgIGlmIChwcmVMaW5lID4gbGFzdExpbmUpIHJldHVybiBQb3MobGFzdExpbmUsIGdldExpbmUoZG9jLCBsYXN0TGluZSkudGV4dC5sZW5ndGgpO1xuICAgICAgcmV0dXJuIGNsaXBUb0xlbihwb3MsIGdldExpbmUoZG9jLCBwcmVMaW5lKS50ZXh0Lmxlbmd0aCk7XG4gICAgfVxuICAgIGlmIChwb3MubGluZSA9PSBjaGFuZ2UudG8ubGluZSArIGRpZmYpXG4gICAgICByZXR1cm4gY2xpcFRvTGVuKHBvcywgbHN0KGNoYW5nZS50ZXh0KS5sZW5ndGggKyAoY2hhbmdlLnRleHQubGVuZ3RoID09IDEgPyBjaGFuZ2UuZnJvbS5jaCA6IDApICtcbiAgICAgICAgICAgICAgICAgICAgICAgZ2V0TGluZShkb2MsIGNoYW5nZS50by5saW5lKS50ZXh0Lmxlbmd0aCAtIGNoYW5nZS50by5jaCk7XG4gICAgdmFyIGluc2lkZSA9IHBvcy5saW5lIC0gY2hhbmdlLmZyb20ubGluZTtcbiAgICByZXR1cm4gY2xpcFRvTGVuKHBvcywgY2hhbmdlLnRleHRbaW5zaWRlXS5sZW5ndGggKyAoaW5zaWRlID8gMCA6IGNoYW5nZS5mcm9tLmNoKSk7XG4gIH1cblxuICAvLyBIaW50IGNhbiBiZSBudWxsfFwiZW5kXCJ8XCJzdGFydFwifFwiYXJvdW5kXCJ8e2FuY2hvcixoZWFkfVxuICBmdW5jdGlvbiBjb21wdXRlU2VsQWZ0ZXJDaGFuZ2UoZG9jLCBjaGFuZ2UsIGhpbnQpIHtcbiAgICBpZiAoaGludCAmJiB0eXBlb2YgaGludCA9PSBcIm9iamVjdFwiKSAvLyBBc3N1bWVkIHRvIGJlIHthbmNob3IsIGhlYWR9IG9iamVjdFxuICAgICAgcmV0dXJuIHthbmNob3I6IGNsaXBQb3N0Q2hhbmdlKGRvYywgY2hhbmdlLCBoaW50LmFuY2hvciksXG4gICAgICAgICAgICAgIGhlYWQ6IGNsaXBQb3N0Q2hhbmdlKGRvYywgY2hhbmdlLCBoaW50LmhlYWQpfTtcblxuICAgIGlmIChoaW50ID09IFwic3RhcnRcIikgcmV0dXJuIHthbmNob3I6IGNoYW5nZS5mcm9tLCBoZWFkOiBjaGFuZ2UuZnJvbX07XG5cbiAgICB2YXIgZW5kID0gY2hhbmdlRW5kKGNoYW5nZSk7XG4gICAgaWYgKGhpbnQgPT0gXCJhcm91bmRcIikgcmV0dXJuIHthbmNob3I6IGNoYW5nZS5mcm9tLCBoZWFkOiBlbmR9O1xuICAgIGlmIChoaW50ID09IFwiZW5kXCIpIHJldHVybiB7YW5jaG9yOiBlbmQsIGhlYWQ6IGVuZH07XG5cbiAgICAvLyBoaW50IGlzIG51bGwsIGxlYXZlIHRoZSBzZWxlY3Rpb24gYWxvbmUgYXMgbXVjaCBhcyBwb3NzaWJsZVxuICAgIHZhciBhZGp1c3RQb3MgPSBmdW5jdGlvbihwb3MpIHtcbiAgICAgIGlmIChwb3NMZXNzKHBvcywgY2hhbmdlLmZyb20pKSByZXR1cm4gcG9zO1xuICAgICAgaWYgKCFwb3NMZXNzKGNoYW5nZS50bywgcG9zKSkgcmV0dXJuIGVuZDtcblxuICAgICAgdmFyIGxpbmUgPSBwb3MubGluZSArIGNoYW5nZS50ZXh0Lmxlbmd0aCAtIChjaGFuZ2UudG8ubGluZSAtIGNoYW5nZS5mcm9tLmxpbmUpIC0gMSwgY2ggPSBwb3MuY2g7XG4gICAgICBpZiAocG9zLmxpbmUgPT0gY2hhbmdlLnRvLmxpbmUpIGNoICs9IGVuZC5jaCAtIGNoYW5nZS50by5jaDtcbiAgICAgIHJldHVybiBQb3MobGluZSwgY2gpO1xuICAgIH07XG4gICAgcmV0dXJuIHthbmNob3I6IGFkanVzdFBvcyhkb2Muc2VsLmFuY2hvciksIGhlYWQ6IGFkanVzdFBvcyhkb2Muc2VsLmhlYWQpfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGZpbHRlckNoYW5nZShkb2MsIGNoYW5nZSwgdXBkYXRlKSB7XG4gICAgdmFyIG9iaiA9IHtcbiAgICAgIGNhbmNlbGVkOiBmYWxzZSxcbiAgICAgIGZyb206IGNoYW5nZS5mcm9tLFxuICAgICAgdG86IGNoYW5nZS50byxcbiAgICAgIHRleHQ6IGNoYW5nZS50ZXh0LFxuICAgICAgb3JpZ2luOiBjaGFuZ2Uub3JpZ2luLFxuICAgICAgY2FuY2VsOiBmdW5jdGlvbigpIHsgdGhpcy5jYW5jZWxlZCA9IHRydWU7IH1cbiAgICB9O1xuICAgIGlmICh1cGRhdGUpIG9iai51cGRhdGUgPSBmdW5jdGlvbihmcm9tLCB0bywgdGV4dCwgb3JpZ2luKSB7XG4gICAgICBpZiAoZnJvbSkgdGhpcy5mcm9tID0gY2xpcFBvcyhkb2MsIGZyb20pO1xuICAgICAgaWYgKHRvKSB0aGlzLnRvID0gY2xpcFBvcyhkb2MsIHRvKTtcbiAgICAgIGlmICh0ZXh0KSB0aGlzLnRleHQgPSB0ZXh0O1xuICAgICAgaWYgKG9yaWdpbiAhPT0gdW5kZWZpbmVkKSB0aGlzLm9yaWdpbiA9IG9yaWdpbjtcbiAgICB9O1xuICAgIHNpZ25hbChkb2MsIFwiYmVmb3JlQ2hhbmdlXCIsIGRvYywgb2JqKTtcbiAgICBpZiAoZG9jLmNtKSBzaWduYWwoZG9jLmNtLCBcImJlZm9yZUNoYW5nZVwiLCBkb2MuY20sIG9iaik7XG5cbiAgICBpZiAob2JqLmNhbmNlbGVkKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4ge2Zyb206IG9iai5mcm9tLCB0bzogb2JqLnRvLCB0ZXh0OiBvYmoudGV4dCwgb3JpZ2luOiBvYmoub3JpZ2lufTtcbiAgfVxuXG4gIC8vIFJlcGxhY2UgdGhlIHJhbmdlIGZyb20gZnJvbSB0byB0byBieSB0aGUgc3RyaW5ncyBpbiByZXBsYWNlbWVudC5cbiAgLy8gY2hhbmdlIGlzIGEge2Zyb20sIHRvLCB0ZXh0IFssIG9yaWdpbl19IG9iamVjdFxuICBmdW5jdGlvbiBtYWtlQ2hhbmdlKGRvYywgY2hhbmdlLCBzZWxVcGRhdGUsIGlnbm9yZVJlYWRPbmx5KSB7XG4gICAgaWYgKGRvYy5jbSkge1xuICAgICAgaWYgKCFkb2MuY20uY3VyT3ApIHJldHVybiBvcGVyYXRpb24oZG9jLmNtLCBtYWtlQ2hhbmdlKShkb2MsIGNoYW5nZSwgc2VsVXBkYXRlLCBpZ25vcmVSZWFkT25seSk7XG4gICAgICBpZiAoZG9jLmNtLnN0YXRlLnN1cHByZXNzRWRpdHMpIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoaGFzSGFuZGxlcihkb2MsIFwiYmVmb3JlQ2hhbmdlXCIpIHx8IGRvYy5jbSAmJiBoYXNIYW5kbGVyKGRvYy5jbSwgXCJiZWZvcmVDaGFuZ2VcIikpIHtcbiAgICAgIGNoYW5nZSA9IGZpbHRlckNoYW5nZShkb2MsIGNoYW5nZSwgdHJ1ZSk7XG4gICAgICBpZiAoIWNoYW5nZSkgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIFBvc3NpYmx5IHNwbGl0IG9yIHN1cHByZXNzIHRoZSB1cGRhdGUgYmFzZWQgb24gdGhlIHByZXNlbmNlXG4gICAgLy8gb2YgcmVhZC1vbmx5IHNwYW5zIGluIGl0cyByYW5nZS5cbiAgICB2YXIgc3BsaXQgPSBzYXdSZWFkT25seVNwYW5zICYmICFpZ25vcmVSZWFkT25seSAmJiByZW1vdmVSZWFkT25seVJhbmdlcyhkb2MsIGNoYW5nZS5mcm9tLCBjaGFuZ2UudG8pO1xuICAgIGlmIChzcGxpdCkge1xuICAgICAgZm9yICh2YXIgaSA9IHNwbGl0Lmxlbmd0aCAtIDE7IGkgPj0gMTsgLS1pKVxuICAgICAgICBtYWtlQ2hhbmdlTm9SZWFkb25seShkb2MsIHtmcm9tOiBzcGxpdFtpXS5mcm9tLCB0bzogc3BsaXRbaV0udG8sIHRleHQ6IFtcIlwiXX0pO1xuICAgICAgaWYgKHNwbGl0Lmxlbmd0aClcbiAgICAgICAgbWFrZUNoYW5nZU5vUmVhZG9ubHkoZG9jLCB7ZnJvbTogc3BsaXRbMF0uZnJvbSwgdG86IHNwbGl0WzBdLnRvLCB0ZXh0OiBjaGFuZ2UudGV4dH0sIHNlbFVwZGF0ZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG1ha2VDaGFuZ2VOb1JlYWRvbmx5KGRvYywgY2hhbmdlLCBzZWxVcGRhdGUpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIG1ha2VDaGFuZ2VOb1JlYWRvbmx5KGRvYywgY2hhbmdlLCBzZWxVcGRhdGUpIHtcbiAgICBpZiAoY2hhbmdlLnRleHQubGVuZ3RoID09IDEgJiYgY2hhbmdlLnRleHRbMF0gPT0gXCJcIiAmJiBwb3NFcShjaGFuZ2UuZnJvbSwgY2hhbmdlLnRvKSkgcmV0dXJuO1xuICAgIHZhciBzZWxBZnRlciA9IGNvbXB1dGVTZWxBZnRlckNoYW5nZShkb2MsIGNoYW5nZSwgc2VsVXBkYXRlKTtcbiAgICBhZGRUb0hpc3RvcnkoZG9jLCBjaGFuZ2UsIHNlbEFmdGVyLCBkb2MuY20gPyBkb2MuY20uY3VyT3AuaWQgOiBOYU4pO1xuXG4gICAgbWFrZUNoYW5nZVNpbmdsZURvYyhkb2MsIGNoYW5nZSwgc2VsQWZ0ZXIsIHN0cmV0Y2hTcGFuc092ZXJDaGFuZ2UoZG9jLCBjaGFuZ2UpKTtcbiAgICB2YXIgcmViYXNlZCA9IFtdO1xuXG4gICAgbGlua2VkRG9jcyhkb2MsIGZ1bmN0aW9uKGRvYywgc2hhcmVkSGlzdCkge1xuICAgICAgaWYgKCFzaGFyZWRIaXN0ICYmIGluZGV4T2YocmViYXNlZCwgZG9jLmhpc3RvcnkpID09IC0xKSB7XG4gICAgICAgIHJlYmFzZUhpc3QoZG9jLmhpc3RvcnksIGNoYW5nZSk7XG4gICAgICAgIHJlYmFzZWQucHVzaChkb2MuaGlzdG9yeSk7XG4gICAgICB9XG4gICAgICBtYWtlQ2hhbmdlU2luZ2xlRG9jKGRvYywgY2hhbmdlLCBudWxsLCBzdHJldGNoU3BhbnNPdmVyQ2hhbmdlKGRvYywgY2hhbmdlKSk7XG4gICAgfSk7XG4gIH1cblxuICBmdW5jdGlvbiBtYWtlQ2hhbmdlRnJvbUhpc3RvcnkoZG9jLCB0eXBlKSB7XG4gICAgaWYgKGRvYy5jbSAmJiBkb2MuY20uc3RhdGUuc3VwcHJlc3NFZGl0cykgcmV0dXJuO1xuXG4gICAgdmFyIGhpc3QgPSBkb2MuaGlzdG9yeTtcbiAgICB2YXIgZXZlbnQgPSAodHlwZSA9PSBcInVuZG9cIiA/IGhpc3QuZG9uZSA6IGhpc3QudW5kb25lKS5wb3AoKTtcbiAgICBpZiAoIWV2ZW50KSByZXR1cm47XG5cbiAgICB2YXIgYW50aSA9IHtjaGFuZ2VzOiBbXSwgYW5jaG9yQmVmb3JlOiBldmVudC5hbmNob3JBZnRlciwgaGVhZEJlZm9yZTogZXZlbnQuaGVhZEFmdGVyLFxuICAgICAgICAgICAgICAgIGFuY2hvckFmdGVyOiBldmVudC5hbmNob3JCZWZvcmUsIGhlYWRBZnRlcjogZXZlbnQuaGVhZEJlZm9yZSxcbiAgICAgICAgICAgICAgICBnZW5lcmF0aW9uOiBoaXN0LmdlbmVyYXRpb259O1xuICAgICh0eXBlID09IFwidW5kb1wiID8gaGlzdC51bmRvbmUgOiBoaXN0LmRvbmUpLnB1c2goYW50aSk7XG4gICAgaGlzdC5nZW5lcmF0aW9uID0gZXZlbnQuZ2VuZXJhdGlvbiB8fCArK2hpc3QubWF4R2VuZXJhdGlvbjtcblxuICAgIHZhciBmaWx0ZXIgPSBoYXNIYW5kbGVyKGRvYywgXCJiZWZvcmVDaGFuZ2VcIikgfHwgZG9jLmNtICYmIGhhc0hhbmRsZXIoZG9jLmNtLCBcImJlZm9yZUNoYW5nZVwiKTtcblxuICAgIGZvciAodmFyIGkgPSBldmVudC5jaGFuZ2VzLmxlbmd0aCAtIDE7IGkgPj0gMDsgLS1pKSB7XG4gICAgICB2YXIgY2hhbmdlID0gZXZlbnQuY2hhbmdlc1tpXTtcbiAgICAgIGNoYW5nZS5vcmlnaW4gPSB0eXBlO1xuICAgICAgaWYgKGZpbHRlciAmJiAhZmlsdGVyQ2hhbmdlKGRvYywgY2hhbmdlLCBmYWxzZSkpIHtcbiAgICAgICAgKHR5cGUgPT0gXCJ1bmRvXCIgPyBoaXN0LmRvbmUgOiBoaXN0LnVuZG9uZSkubGVuZ3RoID0gMDtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBhbnRpLmNoYW5nZXMucHVzaChoaXN0b3J5Q2hhbmdlRnJvbUNoYW5nZShkb2MsIGNoYW5nZSkpO1xuXG4gICAgICB2YXIgYWZ0ZXIgPSBpID8gY29tcHV0ZVNlbEFmdGVyQ2hhbmdlKGRvYywgY2hhbmdlLCBudWxsKVxuICAgICAgICAgICAgICAgICAgICA6IHthbmNob3I6IGV2ZW50LmFuY2hvckJlZm9yZSwgaGVhZDogZXZlbnQuaGVhZEJlZm9yZX07XG4gICAgICBtYWtlQ2hhbmdlU2luZ2xlRG9jKGRvYywgY2hhbmdlLCBhZnRlciwgbWVyZ2VPbGRTcGFucyhkb2MsIGNoYW5nZSkpO1xuICAgICAgdmFyIHJlYmFzZWQgPSBbXTtcblxuICAgICAgbGlua2VkRG9jcyhkb2MsIGZ1bmN0aW9uKGRvYywgc2hhcmVkSGlzdCkge1xuICAgICAgICBpZiAoIXNoYXJlZEhpc3QgJiYgaW5kZXhPZihyZWJhc2VkLCBkb2MuaGlzdG9yeSkgPT0gLTEpIHtcbiAgICAgICAgICByZWJhc2VIaXN0KGRvYy5oaXN0b3J5LCBjaGFuZ2UpO1xuICAgICAgICAgIHJlYmFzZWQucHVzaChkb2MuaGlzdG9yeSk7XG4gICAgICAgIH1cbiAgICAgICAgbWFrZUNoYW5nZVNpbmdsZURvYyhkb2MsIGNoYW5nZSwgbnVsbCwgbWVyZ2VPbGRTcGFucyhkb2MsIGNoYW5nZSkpO1xuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gc2hpZnREb2MoZG9jLCBkaXN0YW5jZSkge1xuICAgIGZ1bmN0aW9uIHNoaWZ0UG9zKHBvcykge3JldHVybiBQb3MocG9zLmxpbmUgKyBkaXN0YW5jZSwgcG9zLmNoKTt9XG4gICAgZG9jLmZpcnN0ICs9IGRpc3RhbmNlO1xuICAgIGlmIChkb2MuY20pIHJlZ0NoYW5nZShkb2MuY20sIGRvYy5maXJzdCwgZG9jLmZpcnN0LCBkaXN0YW5jZSk7XG4gICAgZG9jLnNlbC5oZWFkID0gc2hpZnRQb3MoZG9jLnNlbC5oZWFkKTsgZG9jLnNlbC5hbmNob3IgPSBzaGlmdFBvcyhkb2Muc2VsLmFuY2hvcik7XG4gICAgZG9jLnNlbC5mcm9tID0gc2hpZnRQb3MoZG9jLnNlbC5mcm9tKTsgZG9jLnNlbC50byA9IHNoaWZ0UG9zKGRvYy5zZWwudG8pO1xuICB9XG5cbiAgZnVuY3Rpb24gbWFrZUNoYW5nZVNpbmdsZURvYyhkb2MsIGNoYW5nZSwgc2VsQWZ0ZXIsIHNwYW5zKSB7XG4gICAgaWYgKGRvYy5jbSAmJiAhZG9jLmNtLmN1ck9wKVxuICAgICAgcmV0dXJuIG9wZXJhdGlvbihkb2MuY20sIG1ha2VDaGFuZ2VTaW5nbGVEb2MpKGRvYywgY2hhbmdlLCBzZWxBZnRlciwgc3BhbnMpO1xuXG4gICAgaWYgKGNoYW5nZS50by5saW5lIDwgZG9jLmZpcnN0KSB7XG4gICAgICBzaGlmdERvYyhkb2MsIGNoYW5nZS50ZXh0Lmxlbmd0aCAtIDEgLSAoY2hhbmdlLnRvLmxpbmUgLSBjaGFuZ2UuZnJvbS5saW5lKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChjaGFuZ2UuZnJvbS5saW5lID4gZG9jLmxhc3RMaW5lKCkpIHJldHVybjtcblxuICAgIC8vIENsaXAgdGhlIGNoYW5nZSB0byB0aGUgc2l6ZSBvZiB0aGlzIGRvY1xuICAgIGlmIChjaGFuZ2UuZnJvbS5saW5lIDwgZG9jLmZpcnN0KSB7XG4gICAgICB2YXIgc2hpZnQgPSBjaGFuZ2UudGV4dC5sZW5ndGggLSAxIC0gKGRvYy5maXJzdCAtIGNoYW5nZS5mcm9tLmxpbmUpO1xuICAgICAgc2hpZnREb2MoZG9jLCBzaGlmdCk7XG4gICAgICBjaGFuZ2UgPSB7ZnJvbTogUG9zKGRvYy5maXJzdCwgMCksIHRvOiBQb3MoY2hhbmdlLnRvLmxpbmUgKyBzaGlmdCwgY2hhbmdlLnRvLmNoKSxcbiAgICAgICAgICAgICAgICB0ZXh0OiBbbHN0KGNoYW5nZS50ZXh0KV0sIG9yaWdpbjogY2hhbmdlLm9yaWdpbn07XG4gICAgfVxuICAgIHZhciBsYXN0ID0gZG9jLmxhc3RMaW5lKCk7XG4gICAgaWYgKGNoYW5nZS50by5saW5lID4gbGFzdCkge1xuICAgICAgY2hhbmdlID0ge2Zyb206IGNoYW5nZS5mcm9tLCB0bzogUG9zKGxhc3QsIGdldExpbmUoZG9jLCBsYXN0KS50ZXh0Lmxlbmd0aCksXG4gICAgICAgICAgICAgICAgdGV4dDogW2NoYW5nZS50ZXh0WzBdXSwgb3JpZ2luOiBjaGFuZ2Uub3JpZ2lufTtcbiAgICB9XG5cbiAgICBjaGFuZ2UucmVtb3ZlZCA9IGdldEJldHdlZW4oZG9jLCBjaGFuZ2UuZnJvbSwgY2hhbmdlLnRvKTtcblxuICAgIGlmICghc2VsQWZ0ZXIpIHNlbEFmdGVyID0gY29tcHV0ZVNlbEFmdGVyQ2hhbmdlKGRvYywgY2hhbmdlLCBudWxsKTtcbiAgICBpZiAoZG9jLmNtKSBtYWtlQ2hhbmdlU2luZ2xlRG9jSW5FZGl0b3IoZG9jLmNtLCBjaGFuZ2UsIHNwYW5zLCBzZWxBZnRlcik7XG4gICAgZWxzZSB1cGRhdGVEb2MoZG9jLCBjaGFuZ2UsIHNwYW5zLCBzZWxBZnRlcik7XG4gIH1cblxuICBmdW5jdGlvbiBtYWtlQ2hhbmdlU2luZ2xlRG9jSW5FZGl0b3IoY20sIGNoYW5nZSwgc3BhbnMsIHNlbEFmdGVyKSB7XG4gICAgdmFyIGRvYyA9IGNtLmRvYywgZGlzcGxheSA9IGNtLmRpc3BsYXksIGZyb20gPSBjaGFuZ2UuZnJvbSwgdG8gPSBjaGFuZ2UudG87XG5cbiAgICB2YXIgcmVjb21wdXRlTWF4TGVuZ3RoID0gZmFsc2UsIGNoZWNrV2lkdGhTdGFydCA9IGZyb20ubGluZTtcbiAgICBpZiAoIWNtLm9wdGlvbnMubGluZVdyYXBwaW5nKSB7XG4gICAgICBjaGVja1dpZHRoU3RhcnQgPSBsaW5lTm8odmlzdWFsTGluZShkb2MsIGdldExpbmUoZG9jLCBmcm9tLmxpbmUpKSk7XG4gICAgICBkb2MuaXRlcihjaGVja1dpZHRoU3RhcnQsIHRvLmxpbmUgKyAxLCBmdW5jdGlvbihsaW5lKSB7XG4gICAgICAgIGlmIChsaW5lID09IGRpc3BsYXkubWF4TGluZSkge1xuICAgICAgICAgIHJlY29tcHV0ZU1heExlbmd0aCA9IHRydWU7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmICghcG9zTGVzcyhkb2Muc2VsLmhlYWQsIGNoYW5nZS5mcm9tKSAmJiAhcG9zTGVzcyhjaGFuZ2UudG8sIGRvYy5zZWwuaGVhZCkpXG4gICAgICBjbS5jdXJPcC5jdXJzb3JBY3Rpdml0eSA9IHRydWU7XG5cbiAgICB1cGRhdGVEb2MoZG9jLCBjaGFuZ2UsIHNwYW5zLCBzZWxBZnRlciwgZXN0aW1hdGVIZWlnaHQoY20pKTtcblxuICAgIGlmICghY20ub3B0aW9ucy5saW5lV3JhcHBpbmcpIHtcbiAgICAgIGRvYy5pdGVyKGNoZWNrV2lkdGhTdGFydCwgZnJvbS5saW5lICsgY2hhbmdlLnRleHQubGVuZ3RoLCBmdW5jdGlvbihsaW5lKSB7XG4gICAgICAgIHZhciBsZW4gPSBsaW5lTGVuZ3RoKGRvYywgbGluZSk7XG4gICAgICAgIGlmIChsZW4gPiBkaXNwbGF5Lm1heExpbmVMZW5ndGgpIHtcbiAgICAgICAgICBkaXNwbGF5Lm1heExpbmUgPSBsaW5lO1xuICAgICAgICAgIGRpc3BsYXkubWF4TGluZUxlbmd0aCA9IGxlbjtcbiAgICAgICAgICBkaXNwbGF5Lm1heExpbmVDaGFuZ2VkID0gdHJ1ZTtcbiAgICAgICAgICByZWNvbXB1dGVNYXhMZW5ndGggPSBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICBpZiAocmVjb21wdXRlTWF4TGVuZ3RoKSBjbS5jdXJPcC51cGRhdGVNYXhMaW5lID0gdHJ1ZTtcbiAgICB9XG5cbiAgICAvLyBBZGp1c3QgZnJvbnRpZXIsIHNjaGVkdWxlIHdvcmtlclxuICAgIGRvYy5mcm9udGllciA9IE1hdGgubWluKGRvYy5mcm9udGllciwgZnJvbS5saW5lKTtcbiAgICBzdGFydFdvcmtlcihjbSwgNDAwKTtcblxuICAgIHZhciBsZW5kaWZmID0gY2hhbmdlLnRleHQubGVuZ3RoIC0gKHRvLmxpbmUgLSBmcm9tLmxpbmUpIC0gMTtcbiAgICAvLyBSZW1lbWJlciB0aGF0IHRoZXNlIGxpbmVzIGNoYW5nZWQsIGZvciB1cGRhdGluZyB0aGUgZGlzcGxheVxuICAgIHJlZ0NoYW5nZShjbSwgZnJvbS5saW5lLCB0by5saW5lICsgMSwgbGVuZGlmZik7XG5cbiAgICBpZiAoaGFzSGFuZGxlcihjbSwgXCJjaGFuZ2VcIikpIHtcbiAgICAgIHZhciBjaGFuZ2VPYmogPSB7ZnJvbTogZnJvbSwgdG86IHRvLFxuICAgICAgICAgICAgICAgICAgICAgICB0ZXh0OiBjaGFuZ2UudGV4dCxcbiAgICAgICAgICAgICAgICAgICAgICAgcmVtb3ZlZDogY2hhbmdlLnJlbW92ZWQsXG4gICAgICAgICAgICAgICAgICAgICAgIG9yaWdpbjogY2hhbmdlLm9yaWdpbn07XG4gICAgICBpZiAoY20uY3VyT3AudGV4dENoYW5nZWQpIHtcbiAgICAgICAgZm9yICh2YXIgY3VyID0gY20uY3VyT3AudGV4dENoYW5nZWQ7IGN1ci5uZXh0OyBjdXIgPSBjdXIubmV4dCkge31cbiAgICAgICAgY3VyLm5leHQgPSBjaGFuZ2VPYmo7XG4gICAgICB9IGVsc2UgY20uY3VyT3AudGV4dENoYW5nZWQgPSBjaGFuZ2VPYmo7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gcmVwbGFjZVJhbmdlKGRvYywgY29kZSwgZnJvbSwgdG8sIG9yaWdpbikge1xuICAgIGlmICghdG8pIHRvID0gZnJvbTtcbiAgICBpZiAocG9zTGVzcyh0bywgZnJvbSkpIHsgdmFyIHRtcCA9IHRvOyB0byA9IGZyb207IGZyb20gPSB0bXA7IH1cbiAgICBpZiAodHlwZW9mIGNvZGUgPT0gXCJzdHJpbmdcIikgY29kZSA9IHNwbGl0TGluZXMoY29kZSk7XG4gICAgbWFrZUNoYW5nZShkb2MsIHtmcm9tOiBmcm9tLCB0bzogdG8sIHRleHQ6IGNvZGUsIG9yaWdpbjogb3JpZ2lufSwgbnVsbCk7XG4gIH1cblxuICAvLyBQT1NJVElPTiBPQkpFQ1RcblxuICBmdW5jdGlvbiBQb3MobGluZSwgY2gpIHtcbiAgICBpZiAoISh0aGlzIGluc3RhbmNlb2YgUG9zKSkgcmV0dXJuIG5ldyBQb3MobGluZSwgY2gpO1xuICAgIHRoaXMubGluZSA9IGxpbmU7IHRoaXMuY2ggPSBjaDtcbiAgfVxuICBDb2RlTWlycm9yLlBvcyA9IFBvcztcblxuICBmdW5jdGlvbiBwb3NFcShhLCBiKSB7cmV0dXJuIGEubGluZSA9PSBiLmxpbmUgJiYgYS5jaCA9PSBiLmNoO31cbiAgZnVuY3Rpb24gcG9zTGVzcyhhLCBiKSB7cmV0dXJuIGEubGluZSA8IGIubGluZSB8fCAoYS5saW5lID09IGIubGluZSAmJiBhLmNoIDwgYi5jaCk7fVxuICBmdW5jdGlvbiBjbXAoYSwgYikge3JldHVybiBhLmxpbmUgLSBiLmxpbmUgfHwgYS5jaCAtIGIuY2g7fVxuICBmdW5jdGlvbiBjb3B5UG9zKHgpIHtyZXR1cm4gUG9zKHgubGluZSwgeC5jaCk7fVxuXG4gIC8vIFNFTEVDVElPTlxuXG4gIGZ1bmN0aW9uIGNsaXBMaW5lKGRvYywgbikge3JldHVybiBNYXRoLm1heChkb2MuZmlyc3QsIE1hdGgubWluKG4sIGRvYy5maXJzdCArIGRvYy5zaXplIC0gMSkpO31cbiAgZnVuY3Rpb24gY2xpcFBvcyhkb2MsIHBvcykge1xuICAgIGlmIChwb3MubGluZSA8IGRvYy5maXJzdCkgcmV0dXJuIFBvcyhkb2MuZmlyc3QsIDApO1xuICAgIHZhciBsYXN0ID0gZG9jLmZpcnN0ICsgZG9jLnNpemUgLSAxO1xuICAgIGlmIChwb3MubGluZSA+IGxhc3QpIHJldHVybiBQb3MobGFzdCwgZ2V0TGluZShkb2MsIGxhc3QpLnRleHQubGVuZ3RoKTtcbiAgICByZXR1cm4gY2xpcFRvTGVuKHBvcywgZ2V0TGluZShkb2MsIHBvcy5saW5lKS50ZXh0Lmxlbmd0aCk7XG4gIH1cbiAgZnVuY3Rpb24gY2xpcFRvTGVuKHBvcywgbGluZWxlbikge1xuICAgIHZhciBjaCA9IHBvcy5jaDtcbiAgICBpZiAoY2ggPT0gbnVsbCB8fCBjaCA+IGxpbmVsZW4pIHJldHVybiBQb3MocG9zLmxpbmUsIGxpbmVsZW4pO1xuICAgIGVsc2UgaWYgKGNoIDwgMCkgcmV0dXJuIFBvcyhwb3MubGluZSwgMCk7XG4gICAgZWxzZSByZXR1cm4gcG9zO1xuICB9XG4gIGZ1bmN0aW9uIGlzTGluZShkb2MsIGwpIHtyZXR1cm4gbCA+PSBkb2MuZmlyc3QgJiYgbCA8IGRvYy5maXJzdCArIGRvYy5zaXplO31cblxuICAvLyBJZiBzaGlmdCBpcyBoZWxkLCB0aGlzIHdpbGwgbW92ZSB0aGUgc2VsZWN0aW9uIGFuY2hvci4gT3RoZXJ3aXNlLFxuICAvLyBpdCdsbCBzZXQgdGhlIHdob2xlIHNlbGVjdGlvbi5cbiAgZnVuY3Rpb24gZXh0ZW5kU2VsZWN0aW9uKGRvYywgcG9zLCBvdGhlciwgYmlhcykge1xuICAgIGlmIChkb2Muc2VsLnNoaWZ0IHx8IGRvYy5zZWwuZXh0ZW5kKSB7XG4gICAgICB2YXIgYW5jaG9yID0gZG9jLnNlbC5hbmNob3I7XG4gICAgICBpZiAob3RoZXIpIHtcbiAgICAgICAgdmFyIHBvc0JlZm9yZSA9IHBvc0xlc3MocG9zLCBhbmNob3IpO1xuICAgICAgICBpZiAocG9zQmVmb3JlICE9IHBvc0xlc3Mob3RoZXIsIGFuY2hvcikpIHtcbiAgICAgICAgICBhbmNob3IgPSBwb3M7XG4gICAgICAgICAgcG9zID0gb3RoZXI7XG4gICAgICAgIH0gZWxzZSBpZiAocG9zQmVmb3JlICE9IHBvc0xlc3MocG9zLCBvdGhlcikpIHtcbiAgICAgICAgICBwb3MgPSBvdGhlcjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgc2V0U2VsZWN0aW9uKGRvYywgYW5jaG9yLCBwb3MsIGJpYXMpO1xuICAgIH0gZWxzZSB7XG4gICAgICBzZXRTZWxlY3Rpb24oZG9jLCBwb3MsIG90aGVyIHx8IHBvcywgYmlhcyk7XG4gICAgfVxuICAgIGlmIChkb2MuY20pIGRvYy5jbS5jdXJPcC51c2VyU2VsQ2hhbmdlID0gdHJ1ZTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGZpbHRlclNlbGVjdGlvbkNoYW5nZShkb2MsIGFuY2hvciwgaGVhZCkge1xuICAgIHZhciBvYmogPSB7YW5jaG9yOiBhbmNob3IsIGhlYWQ6IGhlYWR9O1xuICAgIHNpZ25hbChkb2MsIFwiYmVmb3JlU2VsZWN0aW9uQ2hhbmdlXCIsIGRvYywgb2JqKTtcbiAgICBpZiAoZG9jLmNtKSBzaWduYWwoZG9jLmNtLCBcImJlZm9yZVNlbGVjdGlvbkNoYW5nZVwiLCBkb2MuY20sIG9iaik7XG4gICAgb2JqLmFuY2hvciA9IGNsaXBQb3MoZG9jLCBvYmouYW5jaG9yKTsgb2JqLmhlYWQgPSBjbGlwUG9zKGRvYywgb2JqLmhlYWQpO1xuICAgIHJldHVybiBvYmo7XG4gIH1cblxuICAvLyBVcGRhdGUgdGhlIHNlbGVjdGlvbi4gTGFzdCB0d28gYXJncyBhcmUgb25seSB1c2VkIGJ5XG4gIC8vIHVwZGF0ZURvYywgc2luY2UgdGhleSBoYXZlIHRvIGJlIGV4cHJlc3NlZCBpbiB0aGUgbGluZVxuICAvLyBudW1iZXJzIGJlZm9yZSB0aGUgdXBkYXRlLlxuICBmdW5jdGlvbiBzZXRTZWxlY3Rpb24oZG9jLCBhbmNob3IsIGhlYWQsIGJpYXMsIGNoZWNrQXRvbWljKSB7XG4gICAgaWYgKCFjaGVja0F0b21pYyAmJiBoYXNIYW5kbGVyKGRvYywgXCJiZWZvcmVTZWxlY3Rpb25DaGFuZ2VcIikgfHwgZG9jLmNtICYmIGhhc0hhbmRsZXIoZG9jLmNtLCBcImJlZm9yZVNlbGVjdGlvbkNoYW5nZVwiKSkge1xuICAgICAgdmFyIGZpbHRlcmVkID0gZmlsdGVyU2VsZWN0aW9uQ2hhbmdlKGRvYywgYW5jaG9yLCBoZWFkKTtcbiAgICAgIGhlYWQgPSBmaWx0ZXJlZC5oZWFkO1xuICAgICAgYW5jaG9yID0gZmlsdGVyZWQuYW5jaG9yO1xuICAgIH1cblxuICAgIHZhciBzZWwgPSBkb2Muc2VsO1xuICAgIHNlbC5nb2FsQ29sdW1uID0gbnVsbDtcbiAgICBpZiAoYmlhcyA9PSBudWxsKSBiaWFzID0gcG9zTGVzcyhoZWFkLCBzZWwuaGVhZCkgPyAtMSA6IDE7XG4gICAgLy8gU2tpcCBvdmVyIGF0b21pYyBzcGFucy5cbiAgICBpZiAoY2hlY2tBdG9taWMgfHwgIXBvc0VxKGFuY2hvciwgc2VsLmFuY2hvcikpXG4gICAgICBhbmNob3IgPSBza2lwQXRvbWljKGRvYywgYW5jaG9yLCBiaWFzLCBjaGVja0F0b21pYyAhPSBcInB1c2hcIik7XG4gICAgaWYgKGNoZWNrQXRvbWljIHx8ICFwb3NFcShoZWFkLCBzZWwuaGVhZCkpXG4gICAgICBoZWFkID0gc2tpcEF0b21pYyhkb2MsIGhlYWQsIGJpYXMsIGNoZWNrQXRvbWljICE9IFwicHVzaFwiKTtcblxuICAgIGlmIChwb3NFcShzZWwuYW5jaG9yLCBhbmNob3IpICYmIHBvc0VxKHNlbC5oZWFkLCBoZWFkKSkgcmV0dXJuO1xuXG4gICAgc2VsLmFuY2hvciA9IGFuY2hvcjsgc2VsLmhlYWQgPSBoZWFkO1xuICAgIHZhciBpbnYgPSBwb3NMZXNzKGhlYWQsIGFuY2hvcik7XG4gICAgc2VsLmZyb20gPSBpbnYgPyBoZWFkIDogYW5jaG9yO1xuICAgIHNlbC50byA9IGludiA/IGFuY2hvciA6IGhlYWQ7XG5cbiAgICBpZiAoZG9jLmNtKVxuICAgICAgZG9jLmNtLmN1ck9wLnVwZGF0ZUlucHV0ID0gZG9jLmNtLmN1ck9wLnNlbGVjdGlvbkNoYW5nZWQgPVxuICAgICAgICBkb2MuY20uY3VyT3AuY3Vyc29yQWN0aXZpdHkgPSB0cnVlO1xuXG4gICAgc2lnbmFsTGF0ZXIoZG9jLCBcImN1cnNvckFjdGl2aXR5XCIsIGRvYyk7XG4gIH1cblxuICBmdW5jdGlvbiByZUNoZWNrU2VsZWN0aW9uKGNtKSB7XG4gICAgc2V0U2VsZWN0aW9uKGNtLmRvYywgY20uZG9jLnNlbC5mcm9tLCBjbS5kb2Muc2VsLnRvLCBudWxsLCBcInB1c2hcIik7XG4gIH1cblxuICBmdW5jdGlvbiBza2lwQXRvbWljKGRvYywgcG9zLCBiaWFzLCBtYXlDbGVhcikge1xuICAgIHZhciBmbGlwcGVkID0gZmFsc2UsIGN1clBvcyA9IHBvcztcbiAgICB2YXIgZGlyID0gYmlhcyB8fCAxO1xuICAgIGRvYy5jYW50RWRpdCA9IGZhbHNlO1xuICAgIHNlYXJjaDogZm9yICg7Oykge1xuICAgICAgdmFyIGxpbmUgPSBnZXRMaW5lKGRvYywgY3VyUG9zLmxpbmUpO1xuICAgICAgaWYgKGxpbmUubWFya2VkU3BhbnMpIHtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsaW5lLm1hcmtlZFNwYW5zLmxlbmd0aDsgKytpKSB7XG4gICAgICAgICAgdmFyIHNwID0gbGluZS5tYXJrZWRTcGFuc1tpXSwgbSA9IHNwLm1hcmtlcjtcbiAgICAgICAgICBpZiAoKHNwLmZyb20gPT0gbnVsbCB8fCAobS5pbmNsdXNpdmVMZWZ0ID8gc3AuZnJvbSA8PSBjdXJQb3MuY2ggOiBzcC5mcm9tIDwgY3VyUG9zLmNoKSkgJiZcbiAgICAgICAgICAgICAgKHNwLnRvID09IG51bGwgfHwgKG0uaW5jbHVzaXZlUmlnaHQgPyBzcC50byA+PSBjdXJQb3MuY2ggOiBzcC50byA+IGN1clBvcy5jaCkpKSB7XG4gICAgICAgICAgICBpZiAobWF5Q2xlYXIpIHtcbiAgICAgICAgICAgICAgc2lnbmFsKG0sIFwiYmVmb3JlQ3Vyc29yRW50ZXJcIik7XG4gICAgICAgICAgICAgIGlmIChtLmV4cGxpY2l0bHlDbGVhcmVkKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFsaW5lLm1hcmtlZFNwYW5zKSBicmVhaztcbiAgICAgICAgICAgICAgICBlbHNlIHstLWk7IGNvbnRpbnVlO31cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKCFtLmF0b21pYykgY29udGludWU7XG4gICAgICAgICAgICB2YXIgbmV3UG9zID0gbS5maW5kKClbZGlyIDwgMCA/IFwiZnJvbVwiIDogXCJ0b1wiXTtcbiAgICAgICAgICAgIGlmIChwb3NFcShuZXdQb3MsIGN1clBvcykpIHtcbiAgICAgICAgICAgICAgbmV3UG9zLmNoICs9IGRpcjtcbiAgICAgICAgICAgICAgaWYgKG5ld1Bvcy5jaCA8IDApIHtcbiAgICAgICAgICAgICAgICBpZiAobmV3UG9zLmxpbmUgPiBkb2MuZmlyc3QpIG5ld1BvcyA9IGNsaXBQb3MoZG9jLCBQb3MobmV3UG9zLmxpbmUgLSAxKSk7XG4gICAgICAgICAgICAgICAgZWxzZSBuZXdQb3MgPSBudWxsO1xuICAgICAgICAgICAgICB9IGVsc2UgaWYgKG5ld1Bvcy5jaCA+IGxpbmUudGV4dC5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBpZiAobmV3UG9zLmxpbmUgPCBkb2MuZmlyc3QgKyBkb2Muc2l6ZSAtIDEpIG5ld1BvcyA9IFBvcyhuZXdQb3MubGluZSArIDEsIDApO1xuICAgICAgICAgICAgICAgIGVsc2UgbmV3UG9zID0gbnVsbDtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBpZiAoIW5ld1Bvcykge1xuICAgICAgICAgICAgICAgIGlmIChmbGlwcGVkKSB7XG4gICAgICAgICAgICAgICAgICAvLyBEcml2ZW4gaW4gYSBjb3JuZXIgLS0gbm8gdmFsaWQgY3Vyc29yIHBvc2l0aW9uIGZvdW5kIGF0IGFsbFxuICAgICAgICAgICAgICAgICAgLy8gLS0gdHJ5IGFnYWluICp3aXRoKiBjbGVhcmluZywgaWYgd2UgZGlkbid0IGFscmVhZHlcbiAgICAgICAgICAgICAgICAgIGlmICghbWF5Q2xlYXIpIHJldHVybiBza2lwQXRvbWljKGRvYywgcG9zLCBiaWFzLCB0cnVlKTtcbiAgICAgICAgICAgICAgICAgIC8vIE90aGVyd2lzZSwgdHVybiBvZmYgZWRpdGluZyB1bnRpbCBmdXJ0aGVyIG5vdGljZSwgYW5kIHJldHVybiB0aGUgc3RhcnQgb2YgdGhlIGRvY1xuICAgICAgICAgICAgICAgICAgZG9jLmNhbnRFZGl0ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBQb3MoZG9jLmZpcnN0LCAwKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZmxpcHBlZCA9IHRydWU7IG5ld1BvcyA9IHBvczsgZGlyID0gLWRpcjtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY3VyUG9zID0gbmV3UG9zO1xuICAgICAgICAgICAgY29udGludWUgc2VhcmNoO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIGN1clBvcztcbiAgICB9XG4gIH1cblxuICAvLyBTQ1JPTExJTkdcblxuICBmdW5jdGlvbiBzY3JvbGxDdXJzb3JJbnRvVmlldyhjbSkge1xuICAgIHZhciBjb29yZHMgPSBzY3JvbGxQb3NJbnRvVmlldyhjbSwgY20uZG9jLnNlbC5oZWFkLCBudWxsLCBjbS5vcHRpb25zLmN1cnNvclNjcm9sbE1hcmdpbik7XG4gICAgaWYgKCFjbS5zdGF0ZS5mb2N1c2VkKSByZXR1cm47XG4gICAgdmFyIGRpc3BsYXkgPSBjbS5kaXNwbGF5LCBib3ggPSBnZXRSZWN0KGRpc3BsYXkuc2l6ZXIpLCBkb1Njcm9sbCA9IG51bGw7XG4gICAgaWYgKGNvb3Jkcy50b3AgKyBib3gudG9wIDwgMCkgZG9TY3JvbGwgPSB0cnVlO1xuICAgIGVsc2UgaWYgKGNvb3Jkcy5ib3R0b20gKyBib3gudG9wID4gKHdpbmRvdy5pbm5lckhlaWdodCB8fCBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuY2xpZW50SGVpZ2h0KSkgZG9TY3JvbGwgPSBmYWxzZTtcbiAgICBpZiAoZG9TY3JvbGwgIT0gbnVsbCAmJiAhcGhhbnRvbSkge1xuICAgICAgdmFyIHNjcm9sbE5vZGUgPSBlbHQoXCJkaXZcIiwgXCJcXHUyMDBiXCIsIG51bGwsIFwicG9zaXRpb246IGFic29sdXRlOyB0b3A6IFwiICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgIChjb29yZHMudG9wIC0gZGlzcGxheS52aWV3T2Zmc2V0KSArIFwicHg7IGhlaWdodDogXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgKGNvb3Jkcy5ib3R0b20gLSBjb29yZHMudG9wICsgc2Nyb2xsZXJDdXRPZmYpICsgXCJweDsgbGVmdDogXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgY29vcmRzLmxlZnQgKyBcInB4OyB3aWR0aDogMnB4O1wiKTtcbiAgICAgIGNtLmRpc3BsYXkubGluZVNwYWNlLmFwcGVuZENoaWxkKHNjcm9sbE5vZGUpO1xuICAgICAgc2Nyb2xsTm9kZS5zY3JvbGxJbnRvVmlldyhkb1Njcm9sbCk7XG4gICAgICBjbS5kaXNwbGF5LmxpbmVTcGFjZS5yZW1vdmVDaGlsZChzY3JvbGxOb2RlKTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBzY3JvbGxQb3NJbnRvVmlldyhjbSwgcG9zLCBlbmQsIG1hcmdpbikge1xuICAgIGlmIChtYXJnaW4gPT0gbnVsbCkgbWFyZ2luID0gMDtcbiAgICBmb3IgKDs7KSB7XG4gICAgICB2YXIgY2hhbmdlZCA9IGZhbHNlLCBjb29yZHMgPSBjdXJzb3JDb29yZHMoY20sIHBvcyk7XG4gICAgICB2YXIgZW5kQ29vcmRzID0gIWVuZCB8fCBlbmQgPT0gcG9zID8gY29vcmRzIDogY3Vyc29yQ29vcmRzKGNtLCBlbmQpO1xuICAgICAgdmFyIHNjcm9sbFBvcyA9IGNhbGN1bGF0ZVNjcm9sbFBvcyhjbSwgTWF0aC5taW4oY29vcmRzLmxlZnQsIGVuZENvb3Jkcy5sZWZ0KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgTWF0aC5taW4oY29vcmRzLnRvcCwgZW5kQ29vcmRzLnRvcCkgLSBtYXJnaW4sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIE1hdGgubWF4KGNvb3Jkcy5sZWZ0LCBlbmRDb29yZHMubGVmdCksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIE1hdGgubWF4KGNvb3Jkcy5ib3R0b20sIGVuZENvb3Jkcy5ib3R0b20pICsgbWFyZ2luKTtcbiAgICAgIHZhciBzdGFydFRvcCA9IGNtLmRvYy5zY3JvbGxUb3AsIHN0YXJ0TGVmdCA9IGNtLmRvYy5zY3JvbGxMZWZ0O1xuICAgICAgaWYgKHNjcm9sbFBvcy5zY3JvbGxUb3AgIT0gbnVsbCkge1xuICAgICAgICBzZXRTY3JvbGxUb3AoY20sIHNjcm9sbFBvcy5zY3JvbGxUb3ApO1xuICAgICAgICBpZiAoTWF0aC5hYnMoY20uZG9jLnNjcm9sbFRvcCAtIHN0YXJ0VG9wKSA+IDEpIGNoYW5nZWQgPSB0cnVlO1xuICAgICAgfVxuICAgICAgaWYgKHNjcm9sbFBvcy5zY3JvbGxMZWZ0ICE9IG51bGwpIHtcbiAgICAgICAgc2V0U2Nyb2xsTGVmdChjbSwgc2Nyb2xsUG9zLnNjcm9sbExlZnQpO1xuICAgICAgICBpZiAoTWF0aC5hYnMoY20uZG9jLnNjcm9sbExlZnQgLSBzdGFydExlZnQpID4gMSkgY2hhbmdlZCA9IHRydWU7XG4gICAgICB9XG4gICAgICBpZiAoIWNoYW5nZWQpIHJldHVybiBjb29yZHM7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gc2Nyb2xsSW50b1ZpZXcoY20sIHgxLCB5MSwgeDIsIHkyKSB7XG4gICAgdmFyIHNjcm9sbFBvcyA9IGNhbGN1bGF0ZVNjcm9sbFBvcyhjbSwgeDEsIHkxLCB4MiwgeTIpO1xuICAgIGlmIChzY3JvbGxQb3Muc2Nyb2xsVG9wICE9IG51bGwpIHNldFNjcm9sbFRvcChjbSwgc2Nyb2xsUG9zLnNjcm9sbFRvcCk7XG4gICAgaWYgKHNjcm9sbFBvcy5zY3JvbGxMZWZ0ICE9IG51bGwpIHNldFNjcm9sbExlZnQoY20sIHNjcm9sbFBvcy5zY3JvbGxMZWZ0KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNhbGN1bGF0ZVNjcm9sbFBvcyhjbSwgeDEsIHkxLCB4MiwgeTIpIHtcbiAgICB2YXIgZGlzcGxheSA9IGNtLmRpc3BsYXksIHNuYXBNYXJnaW4gPSB0ZXh0SGVpZ2h0KGNtLmRpc3BsYXkpO1xuICAgIGlmICh5MSA8IDApIHkxID0gMDtcbiAgICB2YXIgc2NyZWVuID0gZGlzcGxheS5zY3JvbGxlci5jbGllbnRIZWlnaHQgLSBzY3JvbGxlckN1dE9mZiwgc2NyZWVudG9wID0gZGlzcGxheS5zY3JvbGxlci5zY3JvbGxUb3AsIHJlc3VsdCA9IHt9O1xuICAgIHZhciBkb2NCb3R0b20gPSBjbS5kb2MuaGVpZ2h0ICsgcGFkZGluZ1ZlcnQoZGlzcGxheSk7XG4gICAgdmFyIGF0VG9wID0geTEgPCBzbmFwTWFyZ2luLCBhdEJvdHRvbSA9IHkyID4gZG9jQm90dG9tIC0gc25hcE1hcmdpbjtcbiAgICBpZiAoeTEgPCBzY3JlZW50b3ApIHtcbiAgICAgIHJlc3VsdC5zY3JvbGxUb3AgPSBhdFRvcCA/IDAgOiB5MTtcbiAgICB9IGVsc2UgaWYgKHkyID4gc2NyZWVudG9wICsgc2NyZWVuKSB7XG4gICAgICB2YXIgbmV3VG9wID0gTWF0aC5taW4oeTEsIChhdEJvdHRvbSA/IGRvY0JvdHRvbSA6IHkyKSAtIHNjcmVlbik7XG4gICAgICBpZiAobmV3VG9wICE9IHNjcmVlbnRvcCkgcmVzdWx0LnNjcm9sbFRvcCA9IG5ld1RvcDtcbiAgICB9XG5cbiAgICB2YXIgc2NyZWVudyA9IGRpc3BsYXkuc2Nyb2xsZXIuY2xpZW50V2lkdGggLSBzY3JvbGxlckN1dE9mZiwgc2NyZWVubGVmdCA9IGRpc3BsYXkuc2Nyb2xsZXIuc2Nyb2xsTGVmdDtcbiAgICB4MSArPSBkaXNwbGF5Lmd1dHRlcnMub2Zmc2V0V2lkdGg7IHgyICs9IGRpc3BsYXkuZ3V0dGVycy5vZmZzZXRXaWR0aDtcbiAgICB2YXIgZ3V0dGVydyA9IGRpc3BsYXkuZ3V0dGVycy5vZmZzZXRXaWR0aDtcbiAgICB2YXIgYXRMZWZ0ID0geDEgPCBndXR0ZXJ3ICsgMTA7XG4gICAgaWYgKHgxIDwgc2NyZWVubGVmdCArIGd1dHRlcncgfHwgYXRMZWZ0KSB7XG4gICAgICBpZiAoYXRMZWZ0KSB4MSA9IDA7XG4gICAgICByZXN1bHQuc2Nyb2xsTGVmdCA9IE1hdGgubWF4KDAsIHgxIC0gMTAgLSBndXR0ZXJ3KTtcbiAgICB9IGVsc2UgaWYgKHgyID4gc2NyZWVudyArIHNjcmVlbmxlZnQgLSAzKSB7XG4gICAgICByZXN1bHQuc2Nyb2xsTGVmdCA9IHgyICsgMTAgLSBzY3JlZW53O1xuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgZnVuY3Rpb24gdXBkYXRlU2Nyb2xsUG9zKGNtLCBsZWZ0LCB0b3ApIHtcbiAgICBjbS5jdXJPcC51cGRhdGVTY3JvbGxQb3MgPSB7c2Nyb2xsTGVmdDogbGVmdCA9PSBudWxsID8gY20uZG9jLnNjcm9sbExlZnQgOiBsZWZ0LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzY3JvbGxUb3A6IHRvcCA9PSBudWxsID8gY20uZG9jLnNjcm9sbFRvcCA6IHRvcH07XG4gIH1cblxuICBmdW5jdGlvbiBhZGRUb1Njcm9sbFBvcyhjbSwgbGVmdCwgdG9wKSB7XG4gICAgdmFyIHBvcyA9IGNtLmN1ck9wLnVwZGF0ZVNjcm9sbFBvcyB8fCAoY20uY3VyT3AudXBkYXRlU2Nyb2xsUG9zID0ge3Njcm9sbExlZnQ6IGNtLmRvYy5zY3JvbGxMZWZ0LCBzY3JvbGxUb3A6IGNtLmRvYy5zY3JvbGxUb3B9KTtcbiAgICB2YXIgc2Nyb2xsID0gY20uZGlzcGxheS5zY3JvbGxlcjtcbiAgICBwb3Muc2Nyb2xsVG9wID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oc2Nyb2xsLnNjcm9sbEhlaWdodCAtIHNjcm9sbC5jbGllbnRIZWlnaHQsIHBvcy5zY3JvbGxUb3AgKyB0b3ApKTtcbiAgICBwb3Muc2Nyb2xsTGVmdCA9IE1hdGgubWF4KDAsIE1hdGgubWluKHNjcm9sbC5zY3JvbGxXaWR0aCAtIHNjcm9sbC5jbGllbnRXaWR0aCwgcG9zLnNjcm9sbExlZnQgKyBsZWZ0KSk7XG4gIH1cblxuICAvLyBBUEkgVVRJTElUSUVTXG5cbiAgZnVuY3Rpb24gaW5kZW50TGluZShjbSwgbiwgaG93LCBhZ2dyZXNzaXZlKSB7XG4gICAgdmFyIGRvYyA9IGNtLmRvYywgc3RhdGU7XG4gICAgaWYgKGhvdyA9PSBudWxsKSBob3cgPSBcImFkZFwiO1xuICAgIGlmIChob3cgPT0gXCJzbWFydFwiKSB7XG4gICAgICBpZiAoIWNtLmRvYy5tb2RlLmluZGVudCkgaG93ID0gXCJwcmV2XCI7XG4gICAgICBlbHNlIHN0YXRlID0gZ2V0U3RhdGVCZWZvcmUoY20sIG4pO1xuICAgIH1cblxuICAgIHZhciB0YWJTaXplID0gY20ub3B0aW9ucy50YWJTaXplO1xuICAgIHZhciBsaW5lID0gZ2V0TGluZShkb2MsIG4pLCBjdXJTcGFjZSA9IGNvdW50Q29sdW1uKGxpbmUudGV4dCwgbnVsbCwgdGFiU2l6ZSk7XG4gICAgaWYgKGxpbmUuc3RhdGVBZnRlcikgbGluZS5zdGF0ZUFmdGVyID0gbnVsbDtcbiAgICB2YXIgY3VyU3BhY2VTdHJpbmcgPSBsaW5lLnRleHQubWF0Y2goL15cXHMqLylbMF0sIGluZGVudGF0aW9uO1xuICAgIGlmICghYWdncmVzc2l2ZSAmJiAhL1xcUy8udGVzdChsaW5lLnRleHQpKSB7XG4gICAgICBpbmRlbnRhdGlvbiA9IDA7XG4gICAgICBob3cgPSBcIm5vdFwiO1xuICAgIH0gZWxzZSBpZiAoaG93ID09IFwic21hcnRcIikge1xuICAgICAgaW5kZW50YXRpb24gPSBjbS5kb2MubW9kZS5pbmRlbnQoc3RhdGUsIGxpbmUudGV4dC5zbGljZShjdXJTcGFjZVN0cmluZy5sZW5ndGgpLCBsaW5lLnRleHQpO1xuICAgICAgaWYgKGluZGVudGF0aW9uID09IFBhc3MpIHtcbiAgICAgICAgaWYgKCFhZ2dyZXNzaXZlKSByZXR1cm47XG4gICAgICAgIGhvdyA9IFwicHJldlwiO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoaG93ID09IFwicHJldlwiKSB7XG4gICAgICBpZiAobiA+IGRvYy5maXJzdCkgaW5kZW50YXRpb24gPSBjb3VudENvbHVtbihnZXRMaW5lKGRvYywgbi0xKS50ZXh0LCBudWxsLCB0YWJTaXplKTtcbiAgICAgIGVsc2UgaW5kZW50YXRpb24gPSAwO1xuICAgIH0gZWxzZSBpZiAoaG93ID09IFwiYWRkXCIpIHtcbiAgICAgIGluZGVudGF0aW9uID0gY3VyU3BhY2UgKyBjbS5vcHRpb25zLmluZGVudFVuaXQ7XG4gICAgfSBlbHNlIGlmIChob3cgPT0gXCJzdWJ0cmFjdFwiKSB7XG4gICAgICBpbmRlbnRhdGlvbiA9IGN1clNwYWNlIC0gY20ub3B0aW9ucy5pbmRlbnRVbml0O1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIGhvdyA9PSBcIm51bWJlclwiKSB7XG4gICAgICBpbmRlbnRhdGlvbiA9IGN1clNwYWNlICsgaG93O1xuICAgIH1cbiAgICBpbmRlbnRhdGlvbiA9IE1hdGgubWF4KDAsIGluZGVudGF0aW9uKTtcblxuICAgIHZhciBpbmRlbnRTdHJpbmcgPSBcIlwiLCBwb3MgPSAwO1xuICAgIGlmIChjbS5vcHRpb25zLmluZGVudFdpdGhUYWJzKVxuICAgICAgZm9yICh2YXIgaSA9IE1hdGguZmxvb3IoaW5kZW50YXRpb24gLyB0YWJTaXplKTsgaTsgLS1pKSB7cG9zICs9IHRhYlNpemU7IGluZGVudFN0cmluZyArPSBcIlxcdFwiO31cbiAgICBpZiAocG9zIDwgaW5kZW50YXRpb24pIGluZGVudFN0cmluZyArPSBzcGFjZVN0cihpbmRlbnRhdGlvbiAtIHBvcyk7XG5cbiAgICBpZiAoaW5kZW50U3RyaW5nICE9IGN1clNwYWNlU3RyaW5nKVxuICAgICAgcmVwbGFjZVJhbmdlKGNtLmRvYywgaW5kZW50U3RyaW5nLCBQb3MobiwgMCksIFBvcyhuLCBjdXJTcGFjZVN0cmluZy5sZW5ndGgpLCBcIitpbnB1dFwiKTtcbiAgICBlbHNlIGlmIChkb2Muc2VsLmhlYWQubGluZSA9PSBuICYmIGRvYy5zZWwuaGVhZC5jaCA8IGN1clNwYWNlU3RyaW5nLmxlbmd0aClcbiAgICAgIHNldFNlbGVjdGlvbihkb2MsIFBvcyhuLCBjdXJTcGFjZVN0cmluZy5sZW5ndGgpLCBQb3MobiwgY3VyU3BhY2VTdHJpbmcubGVuZ3RoKSwgMSk7XG4gICAgbGluZS5zdGF0ZUFmdGVyID0gbnVsbDtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNoYW5nZUxpbmUoY20sIGhhbmRsZSwgb3ApIHtcbiAgICB2YXIgbm8gPSBoYW5kbGUsIGxpbmUgPSBoYW5kbGUsIGRvYyA9IGNtLmRvYztcbiAgICBpZiAodHlwZW9mIGhhbmRsZSA9PSBcIm51bWJlclwiKSBsaW5lID0gZ2V0TGluZShkb2MsIGNsaXBMaW5lKGRvYywgaGFuZGxlKSk7XG4gICAgZWxzZSBubyA9IGxpbmVObyhoYW5kbGUpO1xuICAgIGlmIChubyA9PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgICBpZiAob3AobGluZSwgbm8pKSByZWdDaGFuZ2UoY20sIG5vLCBubyArIDEpO1xuICAgIGVsc2UgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIGxpbmU7XG4gIH1cblxuICBmdW5jdGlvbiBmaW5kUG9zSChkb2MsIHBvcywgZGlyLCB1bml0LCB2aXN1YWxseSkge1xuICAgIHZhciBsaW5lID0gcG9zLmxpbmUsIGNoID0gcG9zLmNoLCBvcmlnRGlyID0gZGlyO1xuICAgIHZhciBsaW5lT2JqID0gZ2V0TGluZShkb2MsIGxpbmUpO1xuICAgIHZhciBwb3NzaWJsZSA9IHRydWU7XG4gICAgZnVuY3Rpb24gZmluZE5leHRMaW5lKCkge1xuICAgICAgdmFyIGwgPSBsaW5lICsgZGlyO1xuICAgICAgaWYgKGwgPCBkb2MuZmlyc3QgfHwgbCA+PSBkb2MuZmlyc3QgKyBkb2Muc2l6ZSkgcmV0dXJuIChwb3NzaWJsZSA9IGZhbHNlKTtcbiAgICAgIGxpbmUgPSBsO1xuICAgICAgcmV0dXJuIGxpbmVPYmogPSBnZXRMaW5lKGRvYywgbCk7XG4gICAgfVxuICAgIGZ1bmN0aW9uIG1vdmVPbmNlKGJvdW5kVG9MaW5lKSB7XG4gICAgICB2YXIgbmV4dCA9ICh2aXN1YWxseSA/IG1vdmVWaXN1YWxseSA6IG1vdmVMb2dpY2FsbHkpKGxpbmVPYmosIGNoLCBkaXIsIHRydWUpO1xuICAgICAgaWYgKG5leHQgPT0gbnVsbCkge1xuICAgICAgICBpZiAoIWJvdW5kVG9MaW5lICYmIGZpbmROZXh0TGluZSgpKSB7XG4gICAgICAgICAgaWYgKHZpc3VhbGx5KSBjaCA9IChkaXIgPCAwID8gbGluZVJpZ2h0IDogbGluZUxlZnQpKGxpbmVPYmopO1xuICAgICAgICAgIGVsc2UgY2ggPSBkaXIgPCAwID8gbGluZU9iai50ZXh0Lmxlbmd0aCA6IDA7XG4gICAgICAgIH0gZWxzZSByZXR1cm4gKHBvc3NpYmxlID0gZmFsc2UpO1xuICAgICAgfSBlbHNlIGNoID0gbmV4dDtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIGlmICh1bml0ID09IFwiY2hhclwiKSBtb3ZlT25jZSgpO1xuICAgIGVsc2UgaWYgKHVuaXQgPT0gXCJjb2x1bW5cIikgbW92ZU9uY2UodHJ1ZSk7XG4gICAgZWxzZSBpZiAodW5pdCA9PSBcIndvcmRcIiB8fCB1bml0ID09IFwiZ3JvdXBcIikge1xuICAgICAgdmFyIHNhd1R5cGUgPSBudWxsLCBncm91cCA9IHVuaXQgPT0gXCJncm91cFwiO1xuICAgICAgZm9yICh2YXIgZmlyc3QgPSB0cnVlOzsgZmlyc3QgPSBmYWxzZSkge1xuICAgICAgICBpZiAoZGlyIDwgMCAmJiAhbW92ZU9uY2UoIWZpcnN0KSkgYnJlYWs7XG4gICAgICAgIHZhciBjdXIgPSBsaW5lT2JqLnRleHQuY2hhckF0KGNoKSB8fCBcIlxcblwiO1xuICAgICAgICB2YXIgdHlwZSA9IGlzV29yZENoYXIoY3VyKSA/IFwid1wiXG4gICAgICAgICAgOiBncm91cCAmJiBjdXIgPT0gXCJcXG5cIiA/IFwiblwiXG4gICAgICAgICAgOiAhZ3JvdXAgfHwgL1xccy8udGVzdChjdXIpID8gbnVsbFxuICAgICAgICAgIDogXCJwXCI7XG4gICAgICAgIGlmIChncm91cCAmJiAhZmlyc3QgJiYgIXR5cGUpIHR5cGUgPSBcInNcIjtcbiAgICAgICAgaWYgKHNhd1R5cGUgJiYgc2F3VHlwZSAhPSB0eXBlKSB7XG4gICAgICAgICAgaWYgKGRpciA8IDApIHtkaXIgPSAxOyBtb3ZlT25jZSgpO31cbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlKSBzYXdUeXBlID0gdHlwZTtcbiAgICAgICAgaWYgKGRpciA+IDAgJiYgIW1vdmVPbmNlKCFmaXJzdCkpIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgICB2YXIgcmVzdWx0ID0gc2tpcEF0b21pYyhkb2MsIFBvcyhsaW5lLCBjaCksIG9yaWdEaXIsIHRydWUpO1xuICAgIGlmICghcG9zc2libGUpIHJlc3VsdC5oaXRTaWRlID0gdHJ1ZTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgZnVuY3Rpb24gZmluZFBvc1YoY20sIHBvcywgZGlyLCB1bml0KSB7XG4gICAgdmFyIGRvYyA9IGNtLmRvYywgeCA9IHBvcy5sZWZ0LCB5O1xuICAgIGlmICh1bml0ID09IFwicGFnZVwiKSB7XG4gICAgICB2YXIgcGFnZVNpemUgPSBNYXRoLm1pbihjbS5kaXNwbGF5LndyYXBwZXIuY2xpZW50SGVpZ2h0LCB3aW5kb3cuaW5uZXJIZWlnaHQgfHwgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmNsaWVudEhlaWdodCk7XG4gICAgICB5ID0gcG9zLnRvcCArIGRpciAqIChwYWdlU2l6ZSAtIChkaXIgPCAwID8gMS41IDogLjUpICogdGV4dEhlaWdodChjbS5kaXNwbGF5KSk7XG4gICAgfSBlbHNlIGlmICh1bml0ID09IFwibGluZVwiKSB7XG4gICAgICB5ID0gZGlyID4gMCA/IHBvcy5ib3R0b20gKyAzIDogcG9zLnRvcCAtIDM7XG4gICAgfVxuICAgIGZvciAoOzspIHtcbiAgICAgIHZhciB0YXJnZXQgPSBjb29yZHNDaGFyKGNtLCB4LCB5KTtcbiAgICAgIGlmICghdGFyZ2V0Lm91dHNpZGUpIGJyZWFrO1xuICAgICAgaWYgKGRpciA8IDAgPyB5IDw9IDAgOiB5ID49IGRvYy5oZWlnaHQpIHsgdGFyZ2V0LmhpdFNpZGUgPSB0cnVlOyBicmVhazsgfVxuICAgICAgeSArPSBkaXIgKiA1O1xuICAgIH1cbiAgICByZXR1cm4gdGFyZ2V0O1xuICB9XG5cbiAgZnVuY3Rpb24gZmluZFdvcmRBdChsaW5lLCBwb3MpIHtcbiAgICB2YXIgc3RhcnQgPSBwb3MuY2gsIGVuZCA9IHBvcy5jaDtcbiAgICBpZiAobGluZSkge1xuICAgICAgaWYgKChwb3MueFJlbCA8IDAgfHwgZW5kID09IGxpbmUubGVuZ3RoKSAmJiBzdGFydCkgLS1zdGFydDsgZWxzZSArK2VuZDtcbiAgICAgIHZhciBzdGFydENoYXIgPSBsaW5lLmNoYXJBdChzdGFydCk7XG4gICAgICB2YXIgY2hlY2sgPSBpc1dvcmRDaGFyKHN0YXJ0Q2hhcikgPyBpc1dvcmRDaGFyXG4gICAgICAgIDogL1xccy8udGVzdChzdGFydENoYXIpID8gZnVuY3Rpb24oY2gpIHtyZXR1cm4gL1xccy8udGVzdChjaCk7fVxuICAgICAgICA6IGZ1bmN0aW9uKGNoKSB7cmV0dXJuICEvXFxzLy50ZXN0KGNoKSAmJiAhaXNXb3JkQ2hhcihjaCk7fTtcbiAgICAgIHdoaWxlIChzdGFydCA+IDAgJiYgY2hlY2sobGluZS5jaGFyQXQoc3RhcnQgLSAxKSkpIC0tc3RhcnQ7XG4gICAgICB3aGlsZSAoZW5kIDwgbGluZS5sZW5ndGggJiYgY2hlY2sobGluZS5jaGFyQXQoZW5kKSkpICsrZW5kO1xuICAgIH1cbiAgICByZXR1cm4ge2Zyb206IFBvcyhwb3MubGluZSwgc3RhcnQpLCB0bzogUG9zKHBvcy5saW5lLCBlbmQpfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHNlbGVjdExpbmUoY20sIGxpbmUpIHtcbiAgICBleHRlbmRTZWxlY3Rpb24oY20uZG9jLCBQb3MobGluZSwgMCksIGNsaXBQb3MoY20uZG9jLCBQb3MobGluZSArIDEsIDApKSk7XG4gIH1cblxuICAvLyBQUk9UT1RZUEVcblxuICAvLyBUaGUgcHVibGljbHkgdmlzaWJsZSBBUEkuIE5vdGUgdGhhdCBvcGVyYXRpb24obnVsbCwgZikgbWVhbnNcbiAgLy8gJ3dyYXAgZiBpbiBhbiBvcGVyYXRpb24sIHBlcmZvcm1lZCBvbiBpdHMgYHRoaXNgIHBhcmFtZXRlcidcblxuICBDb2RlTWlycm9yLnByb3RvdHlwZSA9IHtcbiAgICBjb25zdHJ1Y3RvcjogQ29kZU1pcnJvcixcbiAgICBmb2N1czogZnVuY3Rpb24oKXt3aW5kb3cuZm9jdXMoKTsgZm9jdXNJbnB1dCh0aGlzKTsgZmFzdFBvbGwodGhpcyk7fSxcblxuICAgIHNldE9wdGlvbjogZnVuY3Rpb24ob3B0aW9uLCB2YWx1ZSkge1xuICAgICAgdmFyIG9wdGlvbnMgPSB0aGlzLm9wdGlvbnMsIG9sZCA9IG9wdGlvbnNbb3B0aW9uXTtcbiAgICAgIGlmIChvcHRpb25zW29wdGlvbl0gPT0gdmFsdWUgJiYgb3B0aW9uICE9IFwibW9kZVwiKSByZXR1cm47XG4gICAgICBvcHRpb25zW29wdGlvbl0gPSB2YWx1ZTtcbiAgICAgIGlmIChvcHRpb25IYW5kbGVycy5oYXNPd25Qcm9wZXJ0eShvcHRpb24pKVxuICAgICAgICBvcGVyYXRpb24odGhpcywgb3B0aW9uSGFuZGxlcnNbb3B0aW9uXSkodGhpcywgdmFsdWUsIG9sZCk7XG4gICAgfSxcblxuICAgIGdldE9wdGlvbjogZnVuY3Rpb24ob3B0aW9uKSB7cmV0dXJuIHRoaXMub3B0aW9uc1tvcHRpb25dO30sXG4gICAgZ2V0RG9jOiBmdW5jdGlvbigpIHtyZXR1cm4gdGhpcy5kb2M7fSxcblxuICAgIGFkZEtleU1hcDogZnVuY3Rpb24obWFwLCBib3R0b20pIHtcbiAgICAgIHRoaXMuc3RhdGUua2V5TWFwc1tib3R0b20gPyBcInB1c2hcIiA6IFwidW5zaGlmdFwiXShtYXApO1xuICAgIH0sXG4gICAgcmVtb3ZlS2V5TWFwOiBmdW5jdGlvbihtYXApIHtcbiAgICAgIHZhciBtYXBzID0gdGhpcy5zdGF0ZS5rZXlNYXBzO1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBtYXBzLmxlbmd0aDsgKytpKVxuICAgICAgICBpZiAobWFwc1tpXSA9PSBtYXAgfHwgKHR5cGVvZiBtYXBzW2ldICE9IFwic3RyaW5nXCIgJiYgbWFwc1tpXS5uYW1lID09IG1hcCkpIHtcbiAgICAgICAgICBtYXBzLnNwbGljZShpLCAxKTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICBhZGRPdmVybGF5OiBvcGVyYXRpb24obnVsbCwgZnVuY3Rpb24oc3BlYywgb3B0aW9ucykge1xuICAgICAgdmFyIG1vZGUgPSBzcGVjLnRva2VuID8gc3BlYyA6IENvZGVNaXJyb3IuZ2V0TW9kZSh0aGlzLm9wdGlvbnMsIHNwZWMpO1xuICAgICAgaWYgKG1vZGUuc3RhcnRTdGF0ZSkgdGhyb3cgbmV3IEVycm9yKFwiT3ZlcmxheXMgbWF5IG5vdCBiZSBzdGF0ZWZ1bC5cIik7XG4gICAgICB0aGlzLnN0YXRlLm92ZXJsYXlzLnB1c2goe21vZGU6IG1vZGUsIG1vZGVTcGVjOiBzcGVjLCBvcGFxdWU6IG9wdGlvbnMgJiYgb3B0aW9ucy5vcGFxdWV9KTtcbiAgICAgIHRoaXMuc3RhdGUubW9kZUdlbisrO1xuICAgICAgcmVnQ2hhbmdlKHRoaXMpO1xuICAgIH0pLFxuICAgIHJlbW92ZU92ZXJsYXk6IG9wZXJhdGlvbihudWxsLCBmdW5jdGlvbihzcGVjKSB7XG4gICAgICB2YXIgb3ZlcmxheXMgPSB0aGlzLnN0YXRlLm92ZXJsYXlzO1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBvdmVybGF5cy5sZW5ndGg7ICsraSkge1xuICAgICAgICB2YXIgY3VyID0gb3ZlcmxheXNbaV0ubW9kZVNwZWM7XG4gICAgICAgIGlmIChjdXIgPT0gc3BlYyB8fCB0eXBlb2Ygc3BlYyA9PSBcInN0cmluZ1wiICYmIGN1ci5uYW1lID09IHNwZWMpIHtcbiAgICAgICAgICBvdmVybGF5cy5zcGxpY2UoaSwgMSk7XG4gICAgICAgICAgdGhpcy5zdGF0ZS5tb2RlR2VuKys7XG4gICAgICAgICAgcmVnQ2hhbmdlKHRoaXMpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0pLFxuXG4gICAgaW5kZW50TGluZTogb3BlcmF0aW9uKG51bGwsIGZ1bmN0aW9uKG4sIGRpciwgYWdncmVzc2l2ZSkge1xuICAgICAgaWYgKHR5cGVvZiBkaXIgIT0gXCJzdHJpbmdcIiAmJiB0eXBlb2YgZGlyICE9IFwibnVtYmVyXCIpIHtcbiAgICAgICAgaWYgKGRpciA9PSBudWxsKSBkaXIgPSB0aGlzLm9wdGlvbnMuc21hcnRJbmRlbnQgPyBcInNtYXJ0XCIgOiBcInByZXZcIjtcbiAgICAgICAgZWxzZSBkaXIgPSBkaXIgPyBcImFkZFwiIDogXCJzdWJ0cmFjdFwiO1xuICAgICAgfVxuICAgICAgaWYgKGlzTGluZSh0aGlzLmRvYywgbikpIGluZGVudExpbmUodGhpcywgbiwgZGlyLCBhZ2dyZXNzaXZlKTtcbiAgICB9KSxcbiAgICBpbmRlbnRTZWxlY3Rpb246IG9wZXJhdGlvbihudWxsLCBmdW5jdGlvbihob3cpIHtcbiAgICAgIHZhciBzZWwgPSB0aGlzLmRvYy5zZWw7XG4gICAgICBpZiAocG9zRXEoc2VsLmZyb20sIHNlbC50bykpIHJldHVybiBpbmRlbnRMaW5lKHRoaXMsIHNlbC5mcm9tLmxpbmUsIGhvdywgdHJ1ZSk7XG4gICAgICB2YXIgZSA9IHNlbC50by5saW5lIC0gKHNlbC50by5jaCA/IDAgOiAxKTtcbiAgICAgIGZvciAodmFyIGkgPSBzZWwuZnJvbS5saW5lOyBpIDw9IGU7ICsraSkgaW5kZW50TGluZSh0aGlzLCBpLCBob3cpO1xuICAgIH0pLFxuXG4gICAgLy8gRmV0Y2ggdGhlIHBhcnNlciB0b2tlbiBmb3IgYSBnaXZlbiBjaGFyYWN0ZXIuIFVzZWZ1bCBmb3IgaGFja3NcbiAgICAvLyB0aGF0IHdhbnQgdG8gaW5zcGVjdCB0aGUgbW9kZSBzdGF0ZSAoc2F5LCBmb3IgY29tcGxldGlvbikuXG4gICAgZ2V0VG9rZW5BdDogZnVuY3Rpb24ocG9zLCBwcmVjaXNlKSB7XG4gICAgICB2YXIgZG9jID0gdGhpcy5kb2M7XG4gICAgICBwb3MgPSBjbGlwUG9zKGRvYywgcG9zKTtcbiAgICAgIHZhciBzdGF0ZSA9IGdldFN0YXRlQmVmb3JlKHRoaXMsIHBvcy5saW5lLCBwcmVjaXNlKSwgbW9kZSA9IHRoaXMuZG9jLm1vZGU7XG4gICAgICB2YXIgbGluZSA9IGdldExpbmUoZG9jLCBwb3MubGluZSk7XG4gICAgICB2YXIgc3RyZWFtID0gbmV3IFN0cmluZ1N0cmVhbShsaW5lLnRleHQsIHRoaXMub3B0aW9ucy50YWJTaXplKTtcbiAgICAgIHdoaWxlIChzdHJlYW0ucG9zIDwgcG9zLmNoICYmICFzdHJlYW0uZW9sKCkpIHtcbiAgICAgICAgc3RyZWFtLnN0YXJ0ID0gc3RyZWFtLnBvcztcbiAgICAgICAgdmFyIHN0eWxlID0gbW9kZS50b2tlbihzdHJlYW0sIHN0YXRlKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7c3RhcnQ6IHN0cmVhbS5zdGFydCxcbiAgICAgICAgICAgICAgZW5kOiBzdHJlYW0ucG9zLFxuICAgICAgICAgICAgICBzdHJpbmc6IHN0cmVhbS5jdXJyZW50KCksXG4gICAgICAgICAgICAgIGNsYXNzTmFtZTogc3R5bGUgfHwgbnVsbCwgLy8gRGVwcmVjYXRlZCwgdXNlICd0eXBlJyBpbnN0ZWFkXG4gICAgICAgICAgICAgIHR5cGU6IHN0eWxlIHx8IG51bGwsXG4gICAgICAgICAgICAgIHN0YXRlOiBzdGF0ZX07XG4gICAgfSxcblxuICAgIGdldFRva2VuVHlwZUF0OiBmdW5jdGlvbihwb3MpIHtcbiAgICAgIHBvcyA9IGNsaXBQb3ModGhpcy5kb2MsIHBvcyk7XG4gICAgICB2YXIgc3R5bGVzID0gZ2V0TGluZVN0eWxlcyh0aGlzLCBnZXRMaW5lKHRoaXMuZG9jLCBwb3MubGluZSkpO1xuICAgICAgdmFyIGJlZm9yZSA9IDAsIGFmdGVyID0gKHN0eWxlcy5sZW5ndGggLSAxKSAvIDIsIGNoID0gcG9zLmNoO1xuICAgICAgaWYgKGNoID09IDApIHJldHVybiBzdHlsZXNbMl07XG4gICAgICBmb3IgKDs7KSB7XG4gICAgICAgIHZhciBtaWQgPSAoYmVmb3JlICsgYWZ0ZXIpID4+IDE7XG4gICAgICAgIGlmICgobWlkID8gc3R5bGVzW21pZCAqIDIgLSAxXSA6IDApID49IGNoKSBhZnRlciA9IG1pZDtcbiAgICAgICAgZWxzZSBpZiAoc3R5bGVzW21pZCAqIDIgKyAxXSA8IGNoKSBiZWZvcmUgPSBtaWQgKyAxO1xuICAgICAgICBlbHNlIHJldHVybiBzdHlsZXNbbWlkICogMiArIDJdO1xuICAgICAgfVxuICAgIH0sXG5cbiAgICBnZXRNb2RlQXQ6IGZ1bmN0aW9uKHBvcykge1xuICAgICAgdmFyIG1vZGUgPSB0aGlzLmRvYy5tb2RlO1xuICAgICAgaWYgKCFtb2RlLmlubmVyTW9kZSkgcmV0dXJuIG1vZGU7XG4gICAgICByZXR1cm4gQ29kZU1pcnJvci5pbm5lck1vZGUobW9kZSwgdGhpcy5nZXRUb2tlbkF0KHBvcykuc3RhdGUpLm1vZGU7XG4gICAgfSxcblxuICAgIGdldEhlbHBlcjogZnVuY3Rpb24ocG9zLCB0eXBlKSB7XG4gICAgICByZXR1cm4gdGhpcy5nZXRIZWxwZXJzKHBvcywgdHlwZSlbMF07XG4gICAgfSxcblxuICAgIGdldEhlbHBlcnM6IGZ1bmN0aW9uKHBvcywgdHlwZSkge1xuICAgICAgdmFyIGZvdW5kID0gW107XG4gICAgICBpZiAoIWhlbHBlcnMuaGFzT3duUHJvcGVydHkodHlwZSkpIHJldHVybiBoZWxwZXJzO1xuICAgICAgdmFyIGhlbHAgPSBoZWxwZXJzW3R5cGVdLCBtb2RlID0gdGhpcy5nZXRNb2RlQXQocG9zKTtcbiAgICAgIGlmICh0eXBlb2YgbW9kZVt0eXBlXSA9PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIGlmIChoZWxwW21vZGVbdHlwZV1dKSBmb3VuZC5wdXNoKGhlbHBbbW9kZVt0eXBlXV0pO1xuICAgICAgfSBlbHNlIGlmIChtb2RlW3R5cGVdKSB7XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbW9kZVt0eXBlXS5sZW5ndGg7IGkrKykge1xuICAgICAgICAgIHZhciB2YWwgPSBoZWxwW21vZGVbdHlwZV1baV1dO1xuICAgICAgICAgIGlmICh2YWwpIGZvdW5kLnB1c2godmFsKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChtb2RlLmhlbHBlclR5cGUgJiYgaGVscFttb2RlLmhlbHBlclR5cGVdKSB7XG4gICAgICAgIGZvdW5kLnB1c2goaGVscFttb2RlLmhlbHBlclR5cGVdKTtcbiAgICAgIH0gZWxzZSBpZiAoaGVscFttb2RlLm5hbWVdKSB7XG4gICAgICAgIGZvdW5kLnB1c2goaGVscFttb2RlLm5hbWVdKTtcbiAgICAgIH1cbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgaGVscC5fZ2xvYmFsLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIHZhciBjdXIgPSBoZWxwLl9nbG9iYWxbaV07XG4gICAgICAgIGlmIChjdXIucHJlZChtb2RlLCB0aGlzKSAmJiBpbmRleE9mKGZvdW5kLCBjdXIudmFsKSA9PSAtMSlcbiAgICAgICAgICBmb3VuZC5wdXNoKGN1ci52YWwpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGZvdW5kO1xuICAgIH0sXG5cbiAgICBnZXRTdGF0ZUFmdGVyOiBmdW5jdGlvbihsaW5lLCBwcmVjaXNlKSB7XG4gICAgICB2YXIgZG9jID0gdGhpcy5kb2M7XG4gICAgICBsaW5lID0gY2xpcExpbmUoZG9jLCBsaW5lID09IG51bGwgPyBkb2MuZmlyc3QgKyBkb2Muc2l6ZSAtIDE6IGxpbmUpO1xuICAgICAgcmV0dXJuIGdldFN0YXRlQmVmb3JlKHRoaXMsIGxpbmUgKyAxLCBwcmVjaXNlKTtcbiAgICB9LFxuXG4gICAgY3Vyc29yQ29vcmRzOiBmdW5jdGlvbihzdGFydCwgbW9kZSkge1xuICAgICAgdmFyIHBvcywgc2VsID0gdGhpcy5kb2Muc2VsO1xuICAgICAgaWYgKHN0YXJ0ID09IG51bGwpIHBvcyA9IHNlbC5oZWFkO1xuICAgICAgZWxzZSBpZiAodHlwZW9mIHN0YXJ0ID09IFwib2JqZWN0XCIpIHBvcyA9IGNsaXBQb3ModGhpcy5kb2MsIHN0YXJ0KTtcbiAgICAgIGVsc2UgcG9zID0gc3RhcnQgPyBzZWwuZnJvbSA6IHNlbC50bztcbiAgICAgIHJldHVybiBjdXJzb3JDb29yZHModGhpcywgcG9zLCBtb2RlIHx8IFwicGFnZVwiKTtcbiAgICB9LFxuXG4gICAgY2hhckNvb3JkczogZnVuY3Rpb24ocG9zLCBtb2RlKSB7XG4gICAgICByZXR1cm4gY2hhckNvb3Jkcyh0aGlzLCBjbGlwUG9zKHRoaXMuZG9jLCBwb3MpLCBtb2RlIHx8IFwicGFnZVwiKTtcbiAgICB9LFxuXG4gICAgY29vcmRzQ2hhcjogZnVuY3Rpb24oY29vcmRzLCBtb2RlKSB7XG4gICAgICBjb29yZHMgPSBmcm9tQ29vcmRTeXN0ZW0odGhpcywgY29vcmRzLCBtb2RlIHx8IFwicGFnZVwiKTtcbiAgICAgIHJldHVybiBjb29yZHNDaGFyKHRoaXMsIGNvb3Jkcy5sZWZ0LCBjb29yZHMudG9wKTtcbiAgICB9LFxuXG4gICAgbGluZUF0SGVpZ2h0OiBmdW5jdGlvbihoZWlnaHQsIG1vZGUpIHtcbiAgICAgIGhlaWdodCA9IGZyb21Db29yZFN5c3RlbSh0aGlzLCB7dG9wOiBoZWlnaHQsIGxlZnQ6IDB9LCBtb2RlIHx8IFwicGFnZVwiKS50b3A7XG4gICAgICByZXR1cm4gbGluZUF0SGVpZ2h0KHRoaXMuZG9jLCBoZWlnaHQgKyB0aGlzLmRpc3BsYXkudmlld09mZnNldCk7XG4gICAgfSxcbiAgICBoZWlnaHRBdExpbmU6IGZ1bmN0aW9uKGxpbmUsIG1vZGUpIHtcbiAgICAgIHZhciBlbmQgPSBmYWxzZSwgbGFzdCA9IHRoaXMuZG9jLmZpcnN0ICsgdGhpcy5kb2Muc2l6ZSAtIDE7XG4gICAgICBpZiAobGluZSA8IHRoaXMuZG9jLmZpcnN0KSBsaW5lID0gdGhpcy5kb2MuZmlyc3Q7XG4gICAgICBlbHNlIGlmIChsaW5lID4gbGFzdCkgeyBsaW5lID0gbGFzdDsgZW5kID0gdHJ1ZTsgfVxuICAgICAgdmFyIGxpbmVPYmogPSBnZXRMaW5lKHRoaXMuZG9jLCBsaW5lKTtcbiAgICAgIHJldHVybiBpbnRvQ29vcmRTeXN0ZW0odGhpcywgZ2V0TGluZSh0aGlzLmRvYywgbGluZSksIHt0b3A6IDAsIGxlZnQ6IDB9LCBtb2RlIHx8IFwicGFnZVwiKS50b3AgK1xuICAgICAgICAoZW5kID8gbGluZU9iai5oZWlnaHQgOiAwKTtcbiAgICB9LFxuXG4gICAgZGVmYXVsdFRleHRIZWlnaHQ6IGZ1bmN0aW9uKCkgeyByZXR1cm4gdGV4dEhlaWdodCh0aGlzLmRpc3BsYXkpOyB9LFxuICAgIGRlZmF1bHRDaGFyV2lkdGg6IGZ1bmN0aW9uKCkgeyByZXR1cm4gY2hhcldpZHRoKHRoaXMuZGlzcGxheSk7IH0sXG5cbiAgICBzZXRHdXR0ZXJNYXJrZXI6IG9wZXJhdGlvbihudWxsLCBmdW5jdGlvbihsaW5lLCBndXR0ZXJJRCwgdmFsdWUpIHtcbiAgICAgIHJldHVybiBjaGFuZ2VMaW5lKHRoaXMsIGxpbmUsIGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgICAgdmFyIG1hcmtlcnMgPSBsaW5lLmd1dHRlck1hcmtlcnMgfHwgKGxpbmUuZ3V0dGVyTWFya2VycyA9IHt9KTtcbiAgICAgICAgbWFya2Vyc1tndXR0ZXJJRF0gPSB2YWx1ZTtcbiAgICAgICAgaWYgKCF2YWx1ZSAmJiBpc0VtcHR5KG1hcmtlcnMpKSBsaW5lLmd1dHRlck1hcmtlcnMgPSBudWxsO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0pO1xuICAgIH0pLFxuXG4gICAgY2xlYXJHdXR0ZXI6IG9wZXJhdGlvbihudWxsLCBmdW5jdGlvbihndXR0ZXJJRCkge1xuICAgICAgdmFyIGNtID0gdGhpcywgZG9jID0gY20uZG9jLCBpID0gZG9jLmZpcnN0O1xuICAgICAgZG9jLml0ZXIoZnVuY3Rpb24obGluZSkge1xuICAgICAgICBpZiAobGluZS5ndXR0ZXJNYXJrZXJzICYmIGxpbmUuZ3V0dGVyTWFya2Vyc1tndXR0ZXJJRF0pIHtcbiAgICAgICAgICBsaW5lLmd1dHRlck1hcmtlcnNbZ3V0dGVySURdID0gbnVsbDtcbiAgICAgICAgICByZWdDaGFuZ2UoY20sIGksIGkgKyAxKTtcbiAgICAgICAgICBpZiAoaXNFbXB0eShsaW5lLmd1dHRlck1hcmtlcnMpKSBsaW5lLmd1dHRlck1hcmtlcnMgPSBudWxsO1xuICAgICAgICB9XG4gICAgICAgICsraTtcbiAgICAgIH0pO1xuICAgIH0pLFxuXG4gICAgYWRkTGluZUNsYXNzOiBvcGVyYXRpb24obnVsbCwgZnVuY3Rpb24oaGFuZGxlLCB3aGVyZSwgY2xzKSB7XG4gICAgICByZXR1cm4gY2hhbmdlTGluZSh0aGlzLCBoYW5kbGUsIGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgICAgdmFyIHByb3AgPSB3aGVyZSA9PSBcInRleHRcIiA/IFwidGV4dENsYXNzXCIgOiB3aGVyZSA9PSBcImJhY2tncm91bmRcIiA/IFwiYmdDbGFzc1wiIDogXCJ3cmFwQ2xhc3NcIjtcbiAgICAgICAgaWYgKCFsaW5lW3Byb3BdKSBsaW5lW3Byb3BdID0gY2xzO1xuICAgICAgICBlbHNlIGlmIChuZXcgUmVnRXhwKFwiKD86XnxcXFxccylcIiArIGNscyArIFwiKD86JHxcXFxccylcIikudGVzdChsaW5lW3Byb3BdKSkgcmV0dXJuIGZhbHNlO1xuICAgICAgICBlbHNlIGxpbmVbcHJvcF0gKz0gXCIgXCIgKyBjbHM7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSk7XG4gICAgfSksXG5cbiAgICByZW1vdmVMaW5lQ2xhc3M6IG9wZXJhdGlvbihudWxsLCBmdW5jdGlvbihoYW5kbGUsIHdoZXJlLCBjbHMpIHtcbiAgICAgIHJldHVybiBjaGFuZ2VMaW5lKHRoaXMsIGhhbmRsZSwgZnVuY3Rpb24obGluZSkge1xuICAgICAgICB2YXIgcHJvcCA9IHdoZXJlID09IFwidGV4dFwiID8gXCJ0ZXh0Q2xhc3NcIiA6IHdoZXJlID09IFwiYmFja2dyb3VuZFwiID8gXCJiZ0NsYXNzXCIgOiBcIndyYXBDbGFzc1wiO1xuICAgICAgICB2YXIgY3VyID0gbGluZVtwcm9wXTtcbiAgICAgICAgaWYgKCFjdXIpIHJldHVybiBmYWxzZTtcbiAgICAgICAgZWxzZSBpZiAoY2xzID09IG51bGwpIGxpbmVbcHJvcF0gPSBudWxsO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICB2YXIgZm91bmQgPSBjdXIubWF0Y2gobmV3IFJlZ0V4cChcIig/Ol58XFxcXHMrKVwiICsgY2xzICsgXCIoPzokfFxcXFxzKylcIikpO1xuICAgICAgICAgIGlmICghZm91bmQpIHJldHVybiBmYWxzZTtcbiAgICAgICAgICB2YXIgZW5kID0gZm91bmQuaW5kZXggKyBmb3VuZFswXS5sZW5ndGg7XG4gICAgICAgICAgbGluZVtwcm9wXSA9IGN1ci5zbGljZSgwLCBmb3VuZC5pbmRleCkgKyAoIWZvdW5kLmluZGV4IHx8IGVuZCA9PSBjdXIubGVuZ3RoID8gXCJcIiA6IFwiIFwiKSArIGN1ci5zbGljZShlbmQpIHx8IG51bGw7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9KTtcbiAgICB9KSxcblxuICAgIGFkZExpbmVXaWRnZXQ6IG9wZXJhdGlvbihudWxsLCBmdW5jdGlvbihoYW5kbGUsIG5vZGUsIG9wdGlvbnMpIHtcbiAgICAgIHJldHVybiBhZGRMaW5lV2lkZ2V0KHRoaXMsIGhhbmRsZSwgbm9kZSwgb3B0aW9ucyk7XG4gICAgfSksXG5cbiAgICByZW1vdmVMaW5lV2lkZ2V0OiBmdW5jdGlvbih3aWRnZXQpIHsgd2lkZ2V0LmNsZWFyKCk7IH0sXG5cbiAgICBsaW5lSW5mbzogZnVuY3Rpb24obGluZSkge1xuICAgICAgaWYgKHR5cGVvZiBsaW5lID09IFwibnVtYmVyXCIpIHtcbiAgICAgICAgaWYgKCFpc0xpbmUodGhpcy5kb2MsIGxpbmUpKSByZXR1cm4gbnVsbDtcbiAgICAgICAgdmFyIG4gPSBsaW5lO1xuICAgICAgICBsaW5lID0gZ2V0TGluZSh0aGlzLmRvYywgbGluZSk7XG4gICAgICAgIGlmICghbGluZSkgcmV0dXJuIG51bGw7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB2YXIgbiA9IGxpbmVObyhsaW5lKTtcbiAgICAgICAgaWYgKG4gPT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgICByZXR1cm4ge2xpbmU6IG4sIGhhbmRsZTogbGluZSwgdGV4dDogbGluZS50ZXh0LCBndXR0ZXJNYXJrZXJzOiBsaW5lLmd1dHRlck1hcmtlcnMsXG4gICAgICAgICAgICAgIHRleHRDbGFzczogbGluZS50ZXh0Q2xhc3MsIGJnQ2xhc3M6IGxpbmUuYmdDbGFzcywgd3JhcENsYXNzOiBsaW5lLndyYXBDbGFzcyxcbiAgICAgICAgICAgICAgd2lkZ2V0czogbGluZS53aWRnZXRzfTtcbiAgICB9LFxuXG4gICAgZ2V0Vmlld3BvcnQ6IGZ1bmN0aW9uKCkgeyByZXR1cm4ge2Zyb206IHRoaXMuZGlzcGxheS5zaG93aW5nRnJvbSwgdG86IHRoaXMuZGlzcGxheS5zaG93aW5nVG99O30sXG5cbiAgICBhZGRXaWRnZXQ6IGZ1bmN0aW9uKHBvcywgbm9kZSwgc2Nyb2xsLCB2ZXJ0LCBob3Jpeikge1xuICAgICAgdmFyIGRpc3BsYXkgPSB0aGlzLmRpc3BsYXk7XG4gICAgICBwb3MgPSBjdXJzb3JDb29yZHModGhpcywgY2xpcFBvcyh0aGlzLmRvYywgcG9zKSk7XG4gICAgICB2YXIgdG9wID0gcG9zLmJvdHRvbSwgbGVmdCA9IHBvcy5sZWZ0O1xuICAgICAgbm9kZS5zdHlsZS5wb3NpdGlvbiA9IFwiYWJzb2x1dGVcIjtcbiAgICAgIGRpc3BsYXkuc2l6ZXIuYXBwZW5kQ2hpbGQobm9kZSk7XG4gICAgICBpZiAodmVydCA9PSBcIm92ZXJcIikge1xuICAgICAgICB0b3AgPSBwb3MudG9wO1xuICAgICAgfSBlbHNlIGlmICh2ZXJ0ID09IFwiYWJvdmVcIiB8fCB2ZXJ0ID09IFwibmVhclwiKSB7XG4gICAgICAgIHZhciB2c3BhY2UgPSBNYXRoLm1heChkaXNwbGF5LndyYXBwZXIuY2xpZW50SGVpZ2h0LCB0aGlzLmRvYy5oZWlnaHQpLFxuICAgICAgICBoc3BhY2UgPSBNYXRoLm1heChkaXNwbGF5LnNpemVyLmNsaWVudFdpZHRoLCBkaXNwbGF5LmxpbmVTcGFjZS5jbGllbnRXaWR0aCk7XG4gICAgICAgIC8vIERlZmF1bHQgdG8gcG9zaXRpb25pbmcgYWJvdmUgKGlmIHNwZWNpZmllZCBhbmQgcG9zc2libGUpOyBvdGhlcndpc2UgZGVmYXVsdCB0byBwb3NpdGlvbmluZyBiZWxvd1xuICAgICAgICBpZiAoKHZlcnQgPT0gJ2Fib3ZlJyB8fCBwb3MuYm90dG9tICsgbm9kZS5vZmZzZXRIZWlnaHQgPiB2c3BhY2UpICYmIHBvcy50b3AgPiBub2RlLm9mZnNldEhlaWdodClcbiAgICAgICAgICB0b3AgPSBwb3MudG9wIC0gbm9kZS5vZmZzZXRIZWlnaHQ7XG4gICAgICAgIGVsc2UgaWYgKHBvcy5ib3R0b20gKyBub2RlLm9mZnNldEhlaWdodCA8PSB2c3BhY2UpXG4gICAgICAgICAgdG9wID0gcG9zLmJvdHRvbTtcbiAgICAgICAgaWYgKGxlZnQgKyBub2RlLm9mZnNldFdpZHRoID4gaHNwYWNlKVxuICAgICAgICAgIGxlZnQgPSBoc3BhY2UgLSBub2RlLm9mZnNldFdpZHRoO1xuICAgICAgfVxuICAgICAgbm9kZS5zdHlsZS50b3AgPSB0b3AgKyBcInB4XCI7XG4gICAgICBub2RlLnN0eWxlLmxlZnQgPSBub2RlLnN0eWxlLnJpZ2h0ID0gXCJcIjtcbiAgICAgIGlmIChob3JpeiA9PSBcInJpZ2h0XCIpIHtcbiAgICAgICAgbGVmdCA9IGRpc3BsYXkuc2l6ZXIuY2xpZW50V2lkdGggLSBub2RlLm9mZnNldFdpZHRoO1xuICAgICAgICBub2RlLnN0eWxlLnJpZ2h0ID0gXCIwcHhcIjtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChob3JpeiA9PSBcImxlZnRcIikgbGVmdCA9IDA7XG4gICAgICAgIGVsc2UgaWYgKGhvcml6ID09IFwibWlkZGxlXCIpIGxlZnQgPSAoZGlzcGxheS5zaXplci5jbGllbnRXaWR0aCAtIG5vZGUub2Zmc2V0V2lkdGgpIC8gMjtcbiAgICAgICAgbm9kZS5zdHlsZS5sZWZ0ID0gbGVmdCArIFwicHhcIjtcbiAgICAgIH1cbiAgICAgIGlmIChzY3JvbGwpXG4gICAgICAgIHNjcm9sbEludG9WaWV3KHRoaXMsIGxlZnQsIHRvcCwgbGVmdCArIG5vZGUub2Zmc2V0V2lkdGgsIHRvcCArIG5vZGUub2Zmc2V0SGVpZ2h0KTtcbiAgICB9LFxuXG4gICAgdHJpZ2dlck9uS2V5RG93bjogb3BlcmF0aW9uKG51bGwsIG9uS2V5RG93biksXG4gICAgdHJpZ2dlck9uS2V5UHJlc3M6IG9wZXJhdGlvbihudWxsLCBvbktleVByZXNzKSxcbiAgICB0cmlnZ2VyT25LZXlVcDogb3BlcmF0aW9uKG51bGwsIG9uS2V5VXApLFxuXG4gICAgZXhlY0NvbW1hbmQ6IGZ1bmN0aW9uKGNtZCkge1xuICAgICAgaWYgKGNvbW1hbmRzLmhhc093blByb3BlcnR5KGNtZCkpXG4gICAgICAgIHJldHVybiBjb21tYW5kc1tjbWRdKHRoaXMpO1xuICAgIH0sXG5cbiAgICBmaW5kUG9zSDogZnVuY3Rpb24oZnJvbSwgYW1vdW50LCB1bml0LCB2aXN1YWxseSkge1xuICAgICAgdmFyIGRpciA9IDE7XG4gICAgICBpZiAoYW1vdW50IDwgMCkgeyBkaXIgPSAtMTsgYW1vdW50ID0gLWFtb3VudDsgfVxuICAgICAgZm9yICh2YXIgaSA9IDAsIGN1ciA9IGNsaXBQb3ModGhpcy5kb2MsIGZyb20pOyBpIDwgYW1vdW50OyArK2kpIHtcbiAgICAgICAgY3VyID0gZmluZFBvc0godGhpcy5kb2MsIGN1ciwgZGlyLCB1bml0LCB2aXN1YWxseSk7XG4gICAgICAgIGlmIChjdXIuaGl0U2lkZSkgYnJlYWs7XG4gICAgICB9XG4gICAgICByZXR1cm4gY3VyO1xuICAgIH0sXG5cbiAgICBtb3ZlSDogb3BlcmF0aW9uKG51bGwsIGZ1bmN0aW9uKGRpciwgdW5pdCkge1xuICAgICAgdmFyIHNlbCA9IHRoaXMuZG9jLnNlbCwgcG9zO1xuICAgICAgaWYgKHNlbC5zaGlmdCB8fCBzZWwuZXh0ZW5kIHx8IHBvc0VxKHNlbC5mcm9tLCBzZWwudG8pKVxuICAgICAgICBwb3MgPSBmaW5kUG9zSCh0aGlzLmRvYywgc2VsLmhlYWQsIGRpciwgdW5pdCwgdGhpcy5vcHRpb25zLnJ0bE1vdmVWaXN1YWxseSk7XG4gICAgICBlbHNlXG4gICAgICAgIHBvcyA9IGRpciA8IDAgPyBzZWwuZnJvbSA6IHNlbC50bztcbiAgICAgIGV4dGVuZFNlbGVjdGlvbih0aGlzLmRvYywgcG9zLCBwb3MsIGRpcik7XG4gICAgfSksXG5cbiAgICBkZWxldGVIOiBvcGVyYXRpb24obnVsbCwgZnVuY3Rpb24oZGlyLCB1bml0KSB7XG4gICAgICB2YXIgc2VsID0gdGhpcy5kb2Muc2VsO1xuICAgICAgaWYgKCFwb3NFcShzZWwuZnJvbSwgc2VsLnRvKSkgcmVwbGFjZVJhbmdlKHRoaXMuZG9jLCBcIlwiLCBzZWwuZnJvbSwgc2VsLnRvLCBcIitkZWxldGVcIik7XG4gICAgICBlbHNlIHJlcGxhY2VSYW5nZSh0aGlzLmRvYywgXCJcIiwgc2VsLmZyb20sIGZpbmRQb3NIKHRoaXMuZG9jLCBzZWwuaGVhZCwgZGlyLCB1bml0LCBmYWxzZSksIFwiK2RlbGV0ZVwiKTtcbiAgICAgIHRoaXMuY3VyT3AudXNlclNlbENoYW5nZSA9IHRydWU7XG4gICAgfSksXG5cbiAgICBmaW5kUG9zVjogZnVuY3Rpb24oZnJvbSwgYW1vdW50LCB1bml0LCBnb2FsQ29sdW1uKSB7XG4gICAgICB2YXIgZGlyID0gMSwgeCA9IGdvYWxDb2x1bW47XG4gICAgICBpZiAoYW1vdW50IDwgMCkgeyBkaXIgPSAtMTsgYW1vdW50ID0gLWFtb3VudDsgfVxuICAgICAgZm9yICh2YXIgaSA9IDAsIGN1ciA9IGNsaXBQb3ModGhpcy5kb2MsIGZyb20pOyBpIDwgYW1vdW50OyArK2kpIHtcbiAgICAgICAgdmFyIGNvb3JkcyA9IGN1cnNvckNvb3Jkcyh0aGlzLCBjdXIsIFwiZGl2XCIpO1xuICAgICAgICBpZiAoeCA9PSBudWxsKSB4ID0gY29vcmRzLmxlZnQ7XG4gICAgICAgIGVsc2UgY29vcmRzLmxlZnQgPSB4O1xuICAgICAgICBjdXIgPSBmaW5kUG9zVih0aGlzLCBjb29yZHMsIGRpciwgdW5pdCk7XG4gICAgICAgIGlmIChjdXIuaGl0U2lkZSkgYnJlYWs7XG4gICAgICB9XG4gICAgICByZXR1cm4gY3VyO1xuICAgIH0sXG5cbiAgICBtb3ZlVjogb3BlcmF0aW9uKG51bGwsIGZ1bmN0aW9uKGRpciwgdW5pdCkge1xuICAgICAgdmFyIHNlbCA9IHRoaXMuZG9jLnNlbCwgdGFyZ2V0LCBnb2FsO1xuICAgICAgaWYgKHNlbC5zaGlmdCB8fCBzZWwuZXh0ZW5kIHx8IHBvc0VxKHNlbC5mcm9tLCBzZWwudG8pKSB7XG4gICAgICAgIHZhciBwb3MgPSBjdXJzb3JDb29yZHModGhpcywgc2VsLmhlYWQsIFwiZGl2XCIpO1xuICAgICAgICBpZiAoc2VsLmdvYWxDb2x1bW4gIT0gbnVsbCkgcG9zLmxlZnQgPSBzZWwuZ29hbENvbHVtbjtcbiAgICAgICAgdGFyZ2V0ID0gZmluZFBvc1YodGhpcywgcG9zLCBkaXIsIHVuaXQpO1xuICAgICAgICBpZiAodW5pdCA9PSBcInBhZ2VcIikgYWRkVG9TY3JvbGxQb3ModGhpcywgMCwgY2hhckNvb3Jkcyh0aGlzLCB0YXJnZXQsIFwiZGl2XCIpLnRvcCAtIHBvcy50b3ApO1xuICAgICAgICBnb2FsID0gcG9zLmxlZnQ7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0YXJnZXQgPSBkaXIgPCAwID8gc2VsLmZyb20gOiBzZWwudG87XG4gICAgICB9XG4gICAgICBleHRlbmRTZWxlY3Rpb24odGhpcy5kb2MsIHRhcmdldCwgdGFyZ2V0LCBkaXIpO1xuICAgICAgaWYgKGdvYWwgIT0gbnVsbCkgc2VsLmdvYWxDb2x1bW4gPSBnb2FsO1xuICAgIH0pLFxuXG4gICAgdG9nZ2xlT3ZlcndyaXRlOiBmdW5jdGlvbih2YWx1ZSkge1xuICAgICAgaWYgKHZhbHVlICE9IG51bGwgJiYgdmFsdWUgPT0gdGhpcy5zdGF0ZS5vdmVyd3JpdGUpIHJldHVybjtcbiAgICAgIGlmICh0aGlzLnN0YXRlLm92ZXJ3cml0ZSA9ICF0aGlzLnN0YXRlLm92ZXJ3cml0ZSlcbiAgICAgICAgdGhpcy5kaXNwbGF5LmN1cnNvci5jbGFzc05hbWUgKz0gXCIgQ29kZU1pcnJvci1vdmVyd3JpdGVcIjtcbiAgICAgIGVsc2VcbiAgICAgICAgdGhpcy5kaXNwbGF5LmN1cnNvci5jbGFzc05hbWUgPSB0aGlzLmRpc3BsYXkuY3Vyc29yLmNsYXNzTmFtZS5yZXBsYWNlKFwiIENvZGVNaXJyb3Itb3ZlcndyaXRlXCIsIFwiXCIpO1xuXG4gICAgICBzaWduYWwodGhpcywgXCJvdmVyd3JpdGVUb2dnbGVcIiwgdGhpcywgdGhpcy5zdGF0ZS5vdmVyd3JpdGUpO1xuICAgIH0sXG4gICAgaGFzRm9jdXM6IGZ1bmN0aW9uKCkgeyByZXR1cm4gZG9jdW1lbnQuYWN0aXZlRWxlbWVudCA9PSB0aGlzLmRpc3BsYXkuaW5wdXQ7IH0sXG5cbiAgICBzY3JvbGxUbzogb3BlcmF0aW9uKG51bGwsIGZ1bmN0aW9uKHgsIHkpIHtcbiAgICAgIHVwZGF0ZVNjcm9sbFBvcyh0aGlzLCB4LCB5KTtcbiAgICB9KSxcbiAgICBnZXRTY3JvbGxJbmZvOiBmdW5jdGlvbigpIHtcbiAgICAgIHZhciBzY3JvbGxlciA9IHRoaXMuZGlzcGxheS5zY3JvbGxlciwgY28gPSBzY3JvbGxlckN1dE9mZjtcbiAgICAgIHJldHVybiB7bGVmdDogc2Nyb2xsZXIuc2Nyb2xsTGVmdCwgdG9wOiBzY3JvbGxlci5zY3JvbGxUb3AsXG4gICAgICAgICAgICAgIGhlaWdodDogc2Nyb2xsZXIuc2Nyb2xsSGVpZ2h0IC0gY28sIHdpZHRoOiBzY3JvbGxlci5zY3JvbGxXaWR0aCAtIGNvLFxuICAgICAgICAgICAgICBjbGllbnRIZWlnaHQ6IHNjcm9sbGVyLmNsaWVudEhlaWdodCAtIGNvLCBjbGllbnRXaWR0aDogc2Nyb2xsZXIuY2xpZW50V2lkdGggLSBjb307XG4gICAgfSxcblxuICAgIHNjcm9sbEludG9WaWV3OiBvcGVyYXRpb24obnVsbCwgZnVuY3Rpb24ocmFuZ2UsIG1hcmdpbikge1xuICAgICAgaWYgKHJhbmdlID09IG51bGwpIHJhbmdlID0ge2Zyb206IHRoaXMuZG9jLnNlbC5oZWFkLCB0bzogbnVsbH07XG4gICAgICBlbHNlIGlmICh0eXBlb2YgcmFuZ2UgPT0gXCJudW1iZXJcIikgcmFuZ2UgPSB7ZnJvbTogUG9zKHJhbmdlLCAwKSwgdG86IG51bGx9O1xuICAgICAgZWxzZSBpZiAocmFuZ2UuZnJvbSA9PSBudWxsKSByYW5nZSA9IHtmcm9tOiByYW5nZSwgdG86IG51bGx9O1xuICAgICAgaWYgKCFyYW5nZS50bykgcmFuZ2UudG8gPSByYW5nZS5mcm9tO1xuICAgICAgaWYgKCFtYXJnaW4pIG1hcmdpbiA9IDA7XG5cbiAgICAgIHZhciBjb29yZHMgPSByYW5nZTtcbiAgICAgIGlmIChyYW5nZS5mcm9tLmxpbmUgIT0gbnVsbCkge1xuICAgICAgICB0aGlzLmN1ck9wLnNjcm9sbFRvUG9zID0ge2Zyb206IHJhbmdlLmZyb20sIHRvOiByYW5nZS50bywgbWFyZ2luOiBtYXJnaW59O1xuICAgICAgICBjb29yZHMgPSB7ZnJvbTogY3Vyc29yQ29vcmRzKHRoaXMsIHJhbmdlLmZyb20pLFxuICAgICAgICAgICAgICAgICAgdG86IGN1cnNvckNvb3Jkcyh0aGlzLCByYW5nZS50byl9O1xuICAgICAgfVxuICAgICAgdmFyIHNQb3MgPSBjYWxjdWxhdGVTY3JvbGxQb3ModGhpcywgTWF0aC5taW4oY29vcmRzLmZyb20ubGVmdCwgY29vcmRzLnRvLmxlZnQpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgTWF0aC5taW4oY29vcmRzLmZyb20udG9wLCBjb29yZHMudG8udG9wKSAtIG1hcmdpbixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIE1hdGgubWF4KGNvb3Jkcy5mcm9tLnJpZ2h0LCBjb29yZHMudG8ucmlnaHQpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgTWF0aC5tYXgoY29vcmRzLmZyb20uYm90dG9tLCBjb29yZHMudG8uYm90dG9tKSArIG1hcmdpbik7XG4gICAgICB1cGRhdGVTY3JvbGxQb3ModGhpcywgc1Bvcy5zY3JvbGxMZWZ0LCBzUG9zLnNjcm9sbFRvcCk7XG4gICAgfSksXG5cbiAgICBzZXRTaXplOiBvcGVyYXRpb24obnVsbCwgZnVuY3Rpb24od2lkdGgsIGhlaWdodCkge1xuICAgICAgZnVuY3Rpb24gaW50ZXJwcmV0KHZhbCkge1xuICAgICAgICByZXR1cm4gdHlwZW9mIHZhbCA9PSBcIm51bWJlclwiIHx8IC9eXFxkKyQvLnRlc3QoU3RyaW5nKHZhbCkpID8gdmFsICsgXCJweFwiIDogdmFsO1xuICAgICAgfVxuICAgICAgaWYgKHdpZHRoICE9IG51bGwpIHRoaXMuZGlzcGxheS53cmFwcGVyLnN0eWxlLndpZHRoID0gaW50ZXJwcmV0KHdpZHRoKTtcbiAgICAgIGlmIChoZWlnaHQgIT0gbnVsbCkgdGhpcy5kaXNwbGF5LndyYXBwZXIuc3R5bGUuaGVpZ2h0ID0gaW50ZXJwcmV0KGhlaWdodCk7XG4gICAgICBpZiAodGhpcy5vcHRpb25zLmxpbmVXcmFwcGluZylcbiAgICAgICAgdGhpcy5kaXNwbGF5Lm1lYXN1cmVMaW5lQ2FjaGUubGVuZ3RoID0gdGhpcy5kaXNwbGF5Lm1lYXN1cmVMaW5lQ2FjaGVQb3MgPSAwO1xuICAgICAgdGhpcy5jdXJPcC5mb3JjZVVwZGF0ZSA9IHRydWU7XG4gICAgICBzaWduYWwodGhpcywgXCJyZWZyZXNoXCIsIHRoaXMpO1xuICAgIH0pLFxuXG4gICAgb3BlcmF0aW9uOiBmdW5jdGlvbihmKXtyZXR1cm4gcnVuSW5PcCh0aGlzLCBmKTt9LFxuXG4gICAgcmVmcmVzaDogb3BlcmF0aW9uKG51bGwsIGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIG9sZEhlaWdodCA9IHRoaXMuZGlzcGxheS5jYWNoZWRUZXh0SGVpZ2h0O1xuICAgICAgY2xlYXJDYWNoZXModGhpcyk7XG4gICAgICB1cGRhdGVTY3JvbGxQb3ModGhpcywgdGhpcy5kb2Muc2Nyb2xsTGVmdCwgdGhpcy5kb2Muc2Nyb2xsVG9wKTtcbiAgICAgIHJlZ0NoYW5nZSh0aGlzKTtcbiAgICAgIGlmIChvbGRIZWlnaHQgPT0gbnVsbCB8fCBNYXRoLmFicyhvbGRIZWlnaHQgLSB0ZXh0SGVpZ2h0KHRoaXMuZGlzcGxheSkpID4gLjUpXG4gICAgICAgIGVzdGltYXRlTGluZUhlaWdodHModGhpcyk7XG4gICAgICBzaWduYWwodGhpcywgXCJyZWZyZXNoXCIsIHRoaXMpO1xuICAgIH0pLFxuXG4gICAgc3dhcERvYzogb3BlcmF0aW9uKG51bGwsIGZ1bmN0aW9uKGRvYykge1xuICAgICAgdmFyIG9sZCA9IHRoaXMuZG9jO1xuICAgICAgb2xkLmNtID0gbnVsbDtcbiAgICAgIGF0dGFjaERvYyh0aGlzLCBkb2MpO1xuICAgICAgY2xlYXJDYWNoZXModGhpcyk7XG4gICAgICByZXNldElucHV0KHRoaXMsIHRydWUpO1xuICAgICAgdXBkYXRlU2Nyb2xsUG9zKHRoaXMsIGRvYy5zY3JvbGxMZWZ0LCBkb2Muc2Nyb2xsVG9wKTtcbiAgICAgIHNpZ25hbExhdGVyKHRoaXMsIFwic3dhcERvY1wiLCB0aGlzLCBvbGQpO1xuICAgICAgcmV0dXJuIG9sZDtcbiAgICB9KSxcblxuICAgIGdldElucHV0RmllbGQ6IGZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuZGlzcGxheS5pbnB1dDt9LFxuICAgIGdldFdyYXBwZXJFbGVtZW50OiBmdW5jdGlvbigpe3JldHVybiB0aGlzLmRpc3BsYXkud3JhcHBlcjt9LFxuICAgIGdldFNjcm9sbGVyRWxlbWVudDogZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5kaXNwbGF5LnNjcm9sbGVyO30sXG4gICAgZ2V0R3V0dGVyRWxlbWVudDogZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5kaXNwbGF5Lmd1dHRlcnM7fVxuICB9O1xuICBldmVudE1peGluKENvZGVNaXJyb3IpO1xuXG4gIC8vIE9QVElPTiBERUZBVUxUU1xuXG4gIHZhciBvcHRpb25IYW5kbGVycyA9IENvZGVNaXJyb3Iub3B0aW9uSGFuZGxlcnMgPSB7fTtcblxuICAvLyBUaGUgZGVmYXVsdCBjb25maWd1cmF0aW9uIG9wdGlvbnMuXG4gIHZhciBkZWZhdWx0cyA9IENvZGVNaXJyb3IuZGVmYXVsdHMgPSB7fTtcblxuICBmdW5jdGlvbiBvcHRpb24obmFtZSwgZGVmbHQsIGhhbmRsZSwgbm90T25Jbml0KSB7XG4gICAgQ29kZU1pcnJvci5kZWZhdWx0c1tuYW1lXSA9IGRlZmx0O1xuICAgIGlmIChoYW5kbGUpIG9wdGlvbkhhbmRsZXJzW25hbWVdID1cbiAgICAgIG5vdE9uSW5pdCA/IGZ1bmN0aW9uKGNtLCB2YWwsIG9sZCkge2lmIChvbGQgIT0gSW5pdCkgaGFuZGxlKGNtLCB2YWwsIG9sZCk7fSA6IGhhbmRsZTtcbiAgfVxuXG4gIHZhciBJbml0ID0gQ29kZU1pcnJvci5Jbml0ID0ge3RvU3RyaW5nOiBmdW5jdGlvbigpe3JldHVybiBcIkNvZGVNaXJyb3IuSW5pdFwiO319O1xuXG4gIC8vIFRoZXNlIHR3byBhcmUsIG9uIGluaXQsIGNhbGxlZCBmcm9tIHRoZSBjb25zdHJ1Y3RvciBiZWNhdXNlIHRoZXlcbiAgLy8gaGF2ZSB0byBiZSBpbml0aWFsaXplZCBiZWZvcmUgdGhlIGVkaXRvciBjYW4gc3RhcnQgYXQgYWxsLlxuICBvcHRpb24oXCJ2YWx1ZVwiLCBcIlwiLCBmdW5jdGlvbihjbSwgdmFsKSB7XG4gICAgY20uc2V0VmFsdWUodmFsKTtcbiAgfSwgdHJ1ZSk7XG4gIG9wdGlvbihcIm1vZGVcIiwgbnVsbCwgZnVuY3Rpb24oY20sIHZhbCkge1xuICAgIGNtLmRvYy5tb2RlT3B0aW9uID0gdmFsO1xuICAgIGxvYWRNb2RlKGNtKTtcbiAgfSwgdHJ1ZSk7XG5cbiAgb3B0aW9uKFwiaW5kZW50VW5pdFwiLCAyLCBsb2FkTW9kZSwgdHJ1ZSk7XG4gIG9wdGlvbihcImluZGVudFdpdGhUYWJzXCIsIGZhbHNlKTtcbiAgb3B0aW9uKFwic21hcnRJbmRlbnRcIiwgdHJ1ZSk7XG4gIG9wdGlvbihcInRhYlNpemVcIiwgNCwgZnVuY3Rpb24oY20pIHtcbiAgICByZXNldE1vZGVTdGF0ZShjbSk7XG4gICAgY2xlYXJDYWNoZXMoY20pO1xuICAgIHJlZ0NoYW5nZShjbSk7XG4gIH0sIHRydWUpO1xuICBvcHRpb24oXCJzcGVjaWFsQ2hhcnNcIiwgL1tcXHRcXHUwMDAwLVxcdTAwMTlcXHUwMGFkXFx1MjAwYlxcdTIwMjhcXHUyMDI5XFx1ZmVmZl0vZywgZnVuY3Rpb24oY20sIHZhbCkge1xuICAgIGNtLm9wdGlvbnMuc3BlY2lhbENoYXJzID0gbmV3IFJlZ0V4cCh2YWwuc291cmNlICsgKHZhbC50ZXN0KFwiXFx0XCIpID8gXCJcIiA6IFwifFxcdFwiKSwgXCJnXCIpO1xuICAgIGNtLnJlZnJlc2goKTtcbiAgfSwgdHJ1ZSk7XG4gIG9wdGlvbihcInNwZWNpYWxDaGFyUGxhY2Vob2xkZXJcIiwgZGVmYXVsdFNwZWNpYWxDaGFyUGxhY2Vob2xkZXIsIGZ1bmN0aW9uKGNtKSB7Y20ucmVmcmVzaCgpO30sIHRydWUpO1xuICBvcHRpb24oXCJlbGVjdHJpY0NoYXJzXCIsIHRydWUpO1xuICBvcHRpb24oXCJydGxNb3ZlVmlzdWFsbHlcIiwgIXdpbmRvd3MpO1xuICBvcHRpb24oXCJ3aG9sZUxpbmVVcGRhdGVCZWZvcmVcIiwgdHJ1ZSk7XG5cbiAgb3B0aW9uKFwidGhlbWVcIiwgXCJkZWZhdWx0XCIsIGZ1bmN0aW9uKGNtKSB7XG4gICAgdGhlbWVDaGFuZ2VkKGNtKTtcbiAgICBndXR0ZXJzQ2hhbmdlZChjbSk7XG4gIH0sIHRydWUpO1xuICBvcHRpb24oXCJrZXlNYXBcIiwgXCJkZWZhdWx0XCIsIGtleU1hcENoYW5nZWQpO1xuICBvcHRpb24oXCJleHRyYUtleXNcIiwgbnVsbCk7XG5cbiAgb3B0aW9uKFwib25LZXlFdmVudFwiLCBudWxsKTtcbiAgb3B0aW9uKFwib25EcmFnRXZlbnRcIiwgbnVsbCk7XG5cbiAgb3B0aW9uKFwibGluZVdyYXBwaW5nXCIsIGZhbHNlLCB3cmFwcGluZ0NoYW5nZWQsIHRydWUpO1xuICBvcHRpb24oXCJndXR0ZXJzXCIsIFtdLCBmdW5jdGlvbihjbSkge1xuICAgIHNldEd1dHRlcnNGb3JMaW5lTnVtYmVycyhjbS5vcHRpb25zKTtcbiAgICBndXR0ZXJzQ2hhbmdlZChjbSk7XG4gIH0sIHRydWUpO1xuICBvcHRpb24oXCJmaXhlZEd1dHRlclwiLCB0cnVlLCBmdW5jdGlvbihjbSwgdmFsKSB7XG4gICAgY20uZGlzcGxheS5ndXR0ZXJzLnN0eWxlLmxlZnQgPSB2YWwgPyBjb21wZW5zYXRlRm9ySFNjcm9sbChjbS5kaXNwbGF5KSArIFwicHhcIiA6IFwiMFwiO1xuICAgIGNtLnJlZnJlc2goKTtcbiAgfSwgdHJ1ZSk7XG4gIG9wdGlvbihcImNvdmVyR3V0dGVyTmV4dFRvU2Nyb2xsYmFyXCIsIGZhbHNlLCB1cGRhdGVTY3JvbGxiYXJzLCB0cnVlKTtcbiAgb3B0aW9uKFwibGluZU51bWJlcnNcIiwgZmFsc2UsIGZ1bmN0aW9uKGNtKSB7XG4gICAgc2V0R3V0dGVyc0ZvckxpbmVOdW1iZXJzKGNtLm9wdGlvbnMpO1xuICAgIGd1dHRlcnNDaGFuZ2VkKGNtKTtcbiAgfSwgdHJ1ZSk7XG4gIG9wdGlvbihcImZpcnN0TGluZU51bWJlclwiLCAxLCBndXR0ZXJzQ2hhbmdlZCwgdHJ1ZSk7XG4gIG9wdGlvbihcImxpbmVOdW1iZXJGb3JtYXR0ZXJcIiwgZnVuY3Rpb24oaW50ZWdlcikge3JldHVybiBpbnRlZ2VyO30sIGd1dHRlcnNDaGFuZ2VkLCB0cnVlKTtcbiAgb3B0aW9uKFwic2hvd0N1cnNvcldoZW5TZWxlY3RpbmdcIiwgZmFsc2UsIHVwZGF0ZVNlbGVjdGlvbiwgdHJ1ZSk7XG5cbiAgb3B0aW9uKFwicmVzZXRTZWxlY3Rpb25PbkNvbnRleHRNZW51XCIsIHRydWUpO1xuXG4gIG9wdGlvbihcInJlYWRPbmx5XCIsIGZhbHNlLCBmdW5jdGlvbihjbSwgdmFsKSB7XG4gICAgaWYgKHZhbCA9PSBcIm5vY3Vyc29yXCIpIHtcbiAgICAgIG9uQmx1cihjbSk7XG4gICAgICBjbS5kaXNwbGF5LmlucHV0LmJsdXIoKTtcbiAgICAgIGNtLmRpc3BsYXkuZGlzYWJsZWQgPSB0cnVlO1xuICAgIH0gZWxzZSB7XG4gICAgICBjbS5kaXNwbGF5LmRpc2FibGVkID0gZmFsc2U7XG4gICAgICBpZiAoIXZhbCkgcmVzZXRJbnB1dChjbSwgdHJ1ZSk7XG4gICAgfVxuICB9KTtcbiAgb3B0aW9uKFwiZGlzYWJsZUlucHV0XCIsIGZhbHNlLCBmdW5jdGlvbihjbSwgdmFsKSB7aWYgKCF2YWwpIHJlc2V0SW5wdXQoY20sIHRydWUpO30sIHRydWUpO1xuICBvcHRpb24oXCJkcmFnRHJvcFwiLCB0cnVlKTtcblxuICBvcHRpb24oXCJjdXJzb3JCbGlua1JhdGVcIiwgNTMwKTtcbiAgb3B0aW9uKFwiY3Vyc29yU2Nyb2xsTWFyZ2luXCIsIDApO1xuICBvcHRpb24oXCJjdXJzb3JIZWlnaHRcIiwgMSk7XG4gIG9wdGlvbihcIndvcmtUaW1lXCIsIDEwMCk7XG4gIG9wdGlvbihcIndvcmtEZWxheVwiLCAxMDApO1xuICBvcHRpb24oXCJmbGF0dGVuU3BhbnNcIiwgdHJ1ZSwgcmVzZXRNb2RlU3RhdGUsIHRydWUpO1xuICBvcHRpb24oXCJhZGRNb2RlQ2xhc3NcIiwgZmFsc2UsIHJlc2V0TW9kZVN0YXRlLCB0cnVlKTtcbiAgb3B0aW9uKFwicG9sbEludGVydmFsXCIsIDEwMCk7XG4gIG9wdGlvbihcInVuZG9EZXB0aFwiLCA0MCwgZnVuY3Rpb24oY20sIHZhbCl7Y20uZG9jLmhpc3RvcnkudW5kb0RlcHRoID0gdmFsO30pO1xuICBvcHRpb24oXCJoaXN0b3J5RXZlbnREZWxheVwiLCA1MDApO1xuICBvcHRpb24oXCJ2aWV3cG9ydE1hcmdpblwiLCAxMCwgZnVuY3Rpb24oY20pe2NtLnJlZnJlc2goKTt9LCB0cnVlKTtcbiAgb3B0aW9uKFwibWF4SGlnaGxpZ2h0TGVuZ3RoXCIsIDEwMDAwLCByZXNldE1vZGVTdGF0ZSwgdHJ1ZSk7XG4gIG9wdGlvbihcImNydWRlTWVhc3VyaW5nRnJvbVwiLCAxMDAwMCk7XG4gIG9wdGlvbihcIm1vdmVJbnB1dFdpdGhDdXJzb3JcIiwgdHJ1ZSwgZnVuY3Rpb24oY20sIHZhbCkge1xuICAgIGlmICghdmFsKSBjbS5kaXNwbGF5LmlucHV0RGl2LnN0eWxlLnRvcCA9IGNtLmRpc3BsYXkuaW5wdXREaXYuc3R5bGUubGVmdCA9IDA7XG4gIH0pO1xuXG4gIG9wdGlvbihcInRhYmluZGV4XCIsIG51bGwsIGZ1bmN0aW9uKGNtLCB2YWwpIHtcbiAgICBjbS5kaXNwbGF5LmlucHV0LnRhYkluZGV4ID0gdmFsIHx8IFwiXCI7XG4gIH0pO1xuICBvcHRpb24oXCJhdXRvZm9jdXNcIiwgbnVsbCk7XG5cbiAgLy8gTU9ERSBERUZJTklUSU9OIEFORCBRVUVSWUlOR1xuXG4gIC8vIEtub3duIG1vZGVzLCBieSBuYW1lIGFuZCBieSBNSU1FXG4gIHZhciBtb2RlcyA9IENvZGVNaXJyb3IubW9kZXMgPSB7fSwgbWltZU1vZGVzID0gQ29kZU1pcnJvci5taW1lTW9kZXMgPSB7fTtcblxuICBDb2RlTWlycm9yLmRlZmluZU1vZGUgPSBmdW5jdGlvbihuYW1lLCBtb2RlKSB7XG4gICAgaWYgKCFDb2RlTWlycm9yLmRlZmF1bHRzLm1vZGUgJiYgbmFtZSAhPSBcIm51bGxcIikgQ29kZU1pcnJvci5kZWZhdWx0cy5tb2RlID0gbmFtZTtcbiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+IDIpIHtcbiAgICAgIG1vZGUuZGVwZW5kZW5jaWVzID0gW107XG4gICAgICBmb3IgKHZhciBpID0gMjsgaSA8IGFyZ3VtZW50cy5sZW5ndGg7ICsraSkgbW9kZS5kZXBlbmRlbmNpZXMucHVzaChhcmd1bWVudHNbaV0pO1xuICAgIH1cbiAgICBtb2Rlc1tuYW1lXSA9IG1vZGU7XG4gIH07XG5cbiAgQ29kZU1pcnJvci5kZWZpbmVNSU1FID0gZnVuY3Rpb24obWltZSwgc3BlYykge1xuICAgIG1pbWVNb2Rlc1ttaW1lXSA9IHNwZWM7XG4gIH07XG5cbiAgQ29kZU1pcnJvci5yZXNvbHZlTW9kZSA9IGZ1bmN0aW9uKHNwZWMpIHtcbiAgICBpZiAodHlwZW9mIHNwZWMgPT0gXCJzdHJpbmdcIiAmJiBtaW1lTW9kZXMuaGFzT3duUHJvcGVydHkoc3BlYykpIHtcbiAgICAgIHNwZWMgPSBtaW1lTW9kZXNbc3BlY107XG4gICAgfSBlbHNlIGlmIChzcGVjICYmIHR5cGVvZiBzcGVjLm5hbWUgPT0gXCJzdHJpbmdcIiAmJiBtaW1lTW9kZXMuaGFzT3duUHJvcGVydHkoc3BlYy5uYW1lKSkge1xuICAgICAgdmFyIGZvdW5kID0gbWltZU1vZGVzW3NwZWMubmFtZV07XG4gICAgICBpZiAodHlwZW9mIGZvdW5kID09IFwic3RyaW5nXCIpIGZvdW5kID0ge25hbWU6IGZvdW5kfTtcbiAgICAgIHNwZWMgPSBjcmVhdGVPYmooZm91bmQsIHNwZWMpO1xuICAgICAgc3BlYy5uYW1lID0gZm91bmQubmFtZTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBzcGVjID09IFwic3RyaW5nXCIgJiYgL15bXFx3XFwtXStcXC9bXFx3XFwtXStcXCt4bWwkLy50ZXN0KHNwZWMpKSB7XG4gICAgICByZXR1cm4gQ29kZU1pcnJvci5yZXNvbHZlTW9kZShcImFwcGxpY2F0aW9uL3htbFwiKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBzcGVjID09IFwic3RyaW5nXCIpIHJldHVybiB7bmFtZTogc3BlY307XG4gICAgZWxzZSByZXR1cm4gc3BlYyB8fCB7bmFtZTogXCJudWxsXCJ9O1xuICB9O1xuXG4gIENvZGVNaXJyb3IuZ2V0TW9kZSA9IGZ1bmN0aW9uKG9wdGlvbnMsIHNwZWMpIHtcbiAgICB2YXIgc3BlYyA9IENvZGVNaXJyb3IucmVzb2x2ZU1vZGUoc3BlYyk7XG4gICAgdmFyIG1mYWN0b3J5ID0gbW9kZXNbc3BlYy5uYW1lXTtcbiAgICBpZiAoIW1mYWN0b3J5KSByZXR1cm4gQ29kZU1pcnJvci5nZXRNb2RlKG9wdGlvbnMsIFwidGV4dC9wbGFpblwiKTtcbiAgICB2YXIgbW9kZU9iaiA9IG1mYWN0b3J5KG9wdGlvbnMsIHNwZWMpO1xuICAgIGlmIChtb2RlRXh0ZW5zaW9ucy5oYXNPd25Qcm9wZXJ0eShzcGVjLm5hbWUpKSB7XG4gICAgICB2YXIgZXh0cyA9IG1vZGVFeHRlbnNpb25zW3NwZWMubmFtZV07XG4gICAgICBmb3IgKHZhciBwcm9wIGluIGV4dHMpIHtcbiAgICAgICAgaWYgKCFleHRzLmhhc093blByb3BlcnR5KHByb3ApKSBjb250aW51ZTtcbiAgICAgICAgaWYgKG1vZGVPYmouaGFzT3duUHJvcGVydHkocHJvcCkpIG1vZGVPYmpbXCJfXCIgKyBwcm9wXSA9IG1vZGVPYmpbcHJvcF07XG4gICAgICAgIG1vZGVPYmpbcHJvcF0gPSBleHRzW3Byb3BdO1xuICAgICAgfVxuICAgIH1cbiAgICBtb2RlT2JqLm5hbWUgPSBzcGVjLm5hbWU7XG4gICAgaWYgKHNwZWMuaGVscGVyVHlwZSkgbW9kZU9iai5oZWxwZXJUeXBlID0gc3BlYy5oZWxwZXJUeXBlO1xuICAgIGlmIChzcGVjLm1vZGVQcm9wcykgZm9yICh2YXIgcHJvcCBpbiBzcGVjLm1vZGVQcm9wcylcbiAgICAgIG1vZGVPYmpbcHJvcF0gPSBzcGVjLm1vZGVQcm9wc1twcm9wXTtcblxuICAgIHJldHVybiBtb2RlT2JqO1xuICB9O1xuXG4gIENvZGVNaXJyb3IuZGVmaW5lTW9kZShcIm51bGxcIiwgZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHt0b2tlbjogZnVuY3Rpb24oc3RyZWFtKSB7c3RyZWFtLnNraXBUb0VuZCgpO319O1xuICB9KTtcbiAgQ29kZU1pcnJvci5kZWZpbmVNSU1FKFwidGV4dC9wbGFpblwiLCBcIm51bGxcIik7XG5cbiAgdmFyIG1vZGVFeHRlbnNpb25zID0gQ29kZU1pcnJvci5tb2RlRXh0ZW5zaW9ucyA9IHt9O1xuICBDb2RlTWlycm9yLmV4dGVuZE1vZGUgPSBmdW5jdGlvbihtb2RlLCBwcm9wZXJ0aWVzKSB7XG4gICAgdmFyIGV4dHMgPSBtb2RlRXh0ZW5zaW9ucy5oYXNPd25Qcm9wZXJ0eShtb2RlKSA/IG1vZGVFeHRlbnNpb25zW21vZGVdIDogKG1vZGVFeHRlbnNpb25zW21vZGVdID0ge30pO1xuICAgIGNvcHlPYmoocHJvcGVydGllcywgZXh0cyk7XG4gIH07XG5cbiAgLy8gRVhURU5TSU9OU1xuXG4gIENvZGVNaXJyb3IuZGVmaW5lRXh0ZW5zaW9uID0gZnVuY3Rpb24obmFtZSwgZnVuYykge1xuICAgIENvZGVNaXJyb3IucHJvdG90eXBlW25hbWVdID0gZnVuYztcbiAgfTtcbiAgQ29kZU1pcnJvci5kZWZpbmVEb2NFeHRlbnNpb24gPSBmdW5jdGlvbihuYW1lLCBmdW5jKSB7XG4gICAgRG9jLnByb3RvdHlwZVtuYW1lXSA9IGZ1bmM7XG4gIH07XG4gIENvZGVNaXJyb3IuZGVmaW5lT3B0aW9uID0gb3B0aW9uO1xuXG4gIHZhciBpbml0SG9va3MgPSBbXTtcbiAgQ29kZU1pcnJvci5kZWZpbmVJbml0SG9vayA9IGZ1bmN0aW9uKGYpIHtpbml0SG9va3MucHVzaChmKTt9O1xuXG4gIHZhciBoZWxwZXJzID0gQ29kZU1pcnJvci5oZWxwZXJzID0ge307XG4gIENvZGVNaXJyb3IucmVnaXN0ZXJIZWxwZXIgPSBmdW5jdGlvbih0eXBlLCBuYW1lLCB2YWx1ZSkge1xuICAgIGlmICghaGVscGVycy5oYXNPd25Qcm9wZXJ0eSh0eXBlKSkgaGVscGVyc1t0eXBlXSA9IENvZGVNaXJyb3JbdHlwZV0gPSB7X2dsb2JhbDogW119O1xuICAgIGhlbHBlcnNbdHlwZV1bbmFtZV0gPSB2YWx1ZTtcbiAgfTtcbiAgQ29kZU1pcnJvci5yZWdpc3Rlckdsb2JhbEhlbHBlciA9IGZ1bmN0aW9uKHR5cGUsIG5hbWUsIHByZWRpY2F0ZSwgdmFsdWUpIHtcbiAgICBDb2RlTWlycm9yLnJlZ2lzdGVySGVscGVyKHR5cGUsIG5hbWUsIHZhbHVlKTtcbiAgICBoZWxwZXJzW3R5cGVdLl9nbG9iYWwucHVzaCh7cHJlZDogcHJlZGljYXRlLCB2YWw6IHZhbHVlfSk7XG4gIH07XG5cbiAgLy8gVVRJTElUSUVTXG5cbiAgQ29kZU1pcnJvci5pc1dvcmRDaGFyID0gaXNXb3JkQ2hhcjtcblxuICAvLyBNT0RFIFNUQVRFIEhBTkRMSU5HXG5cbiAgLy8gVXRpbGl0eSBmdW5jdGlvbnMgZm9yIHdvcmtpbmcgd2l0aCBzdGF0ZS4gRXhwb3J0ZWQgYmVjYXVzZSBtb2Rlc1xuICAvLyBzb21ldGltZXMgbmVlZCB0byBkbyB0aGlzLlxuICBmdW5jdGlvbiBjb3B5U3RhdGUobW9kZSwgc3RhdGUpIHtcbiAgICBpZiAoc3RhdGUgPT09IHRydWUpIHJldHVybiBzdGF0ZTtcbiAgICBpZiAobW9kZS5jb3B5U3RhdGUpIHJldHVybiBtb2RlLmNvcHlTdGF0ZShzdGF0ZSk7XG4gICAgdmFyIG5zdGF0ZSA9IHt9O1xuICAgIGZvciAodmFyIG4gaW4gc3RhdGUpIHtcbiAgICAgIHZhciB2YWwgPSBzdGF0ZVtuXTtcbiAgICAgIGlmICh2YWwgaW5zdGFuY2VvZiBBcnJheSkgdmFsID0gdmFsLmNvbmNhdChbXSk7XG4gICAgICBuc3RhdGVbbl0gPSB2YWw7XG4gICAgfVxuICAgIHJldHVybiBuc3RhdGU7XG4gIH1cbiAgQ29kZU1pcnJvci5jb3B5U3RhdGUgPSBjb3B5U3RhdGU7XG5cbiAgZnVuY3Rpb24gc3RhcnRTdGF0ZShtb2RlLCBhMSwgYTIpIHtcbiAgICByZXR1cm4gbW9kZS5zdGFydFN0YXRlID8gbW9kZS5zdGFydFN0YXRlKGExLCBhMikgOiB0cnVlO1xuICB9XG4gIENvZGVNaXJyb3Iuc3RhcnRTdGF0ZSA9IHN0YXJ0U3RhdGU7XG5cbiAgQ29kZU1pcnJvci5pbm5lck1vZGUgPSBmdW5jdGlvbihtb2RlLCBzdGF0ZSkge1xuICAgIHdoaWxlIChtb2RlLmlubmVyTW9kZSkge1xuICAgICAgdmFyIGluZm8gPSBtb2RlLmlubmVyTW9kZShzdGF0ZSk7XG4gICAgICBpZiAoIWluZm8gfHwgaW5mby5tb2RlID09IG1vZGUpIGJyZWFrO1xuICAgICAgc3RhdGUgPSBpbmZvLnN0YXRlO1xuICAgICAgbW9kZSA9IGluZm8ubW9kZTtcbiAgICB9XG4gICAgcmV0dXJuIGluZm8gfHwge21vZGU6IG1vZGUsIHN0YXRlOiBzdGF0ZX07XG4gIH07XG5cbiAgLy8gU1RBTkRBUkQgQ09NTUFORFNcblxuICB2YXIgY29tbWFuZHMgPSBDb2RlTWlycm9yLmNvbW1hbmRzID0ge1xuICAgIHNlbGVjdEFsbDogZnVuY3Rpb24oY20pIHtjbS5zZXRTZWxlY3Rpb24oUG9zKGNtLmZpcnN0TGluZSgpLCAwKSwgUG9zKGNtLmxhc3RMaW5lKCkpKTt9LFxuICAgIGtpbGxMaW5lOiBmdW5jdGlvbihjbSkge1xuICAgICAgdmFyIGZyb20gPSBjbS5nZXRDdXJzb3IodHJ1ZSksIHRvID0gY20uZ2V0Q3Vyc29yKGZhbHNlKSwgc2VsID0gIXBvc0VxKGZyb20sIHRvKTtcbiAgICAgIGlmICghc2VsICYmIGNtLmdldExpbmUoZnJvbS5saW5lKS5sZW5ndGggPT0gZnJvbS5jaClcbiAgICAgICAgY20ucmVwbGFjZVJhbmdlKFwiXCIsIGZyb20sIFBvcyhmcm9tLmxpbmUgKyAxLCAwKSwgXCIrZGVsZXRlXCIpO1xuICAgICAgZWxzZSBjbS5yZXBsYWNlUmFuZ2UoXCJcIiwgZnJvbSwgc2VsID8gdG8gOiBQb3MoZnJvbS5saW5lKSwgXCIrZGVsZXRlXCIpO1xuICAgIH0sXG4gICAgZGVsZXRlTGluZTogZnVuY3Rpb24oY20pIHtcbiAgICAgIHZhciBsID0gY20uZ2V0Q3Vyc29yKCkubGluZTtcbiAgICAgIGNtLnJlcGxhY2VSYW5nZShcIlwiLCBQb3MobCwgMCksIFBvcyhsICsgMSwgMCksIFwiK2RlbGV0ZVwiKTtcbiAgICB9LFxuICAgIGRlbExpbmVMZWZ0OiBmdW5jdGlvbihjbSkge1xuICAgICAgdmFyIGN1ciA9IGNtLmdldEN1cnNvcigpO1xuICAgICAgY20ucmVwbGFjZVJhbmdlKFwiXCIsIFBvcyhjdXIubGluZSwgMCksIGN1ciwgXCIrZGVsZXRlXCIpO1xuICAgIH0sXG4gICAgdW5kbzogZnVuY3Rpb24oY20pIHtjbS51bmRvKCk7fSxcbiAgICByZWRvOiBmdW5jdGlvbihjbSkge2NtLnJlZG8oKTt9LFxuICAgIGdvRG9jU3RhcnQ6IGZ1bmN0aW9uKGNtKSB7Y20uZXh0ZW5kU2VsZWN0aW9uKFBvcyhjbS5maXJzdExpbmUoKSwgMCkpO30sXG4gICAgZ29Eb2NFbmQ6IGZ1bmN0aW9uKGNtKSB7Y20uZXh0ZW5kU2VsZWN0aW9uKFBvcyhjbS5sYXN0TGluZSgpKSk7fSxcbiAgICBnb0xpbmVTdGFydDogZnVuY3Rpb24oY20pIHtcbiAgICAgIGNtLmV4dGVuZFNlbGVjdGlvbihsaW5lU3RhcnQoY20sIGNtLmdldEN1cnNvcigpLmxpbmUpKTtcbiAgICB9LFxuICAgIGdvTGluZVN0YXJ0U21hcnQ6IGZ1bmN0aW9uKGNtKSB7XG4gICAgICB2YXIgY3VyID0gY20uZ2V0Q3Vyc29yKCksIHN0YXJ0ID0gbGluZVN0YXJ0KGNtLCBjdXIubGluZSk7XG4gICAgICB2YXIgbGluZSA9IGNtLmdldExpbmVIYW5kbGUoc3RhcnQubGluZSk7XG4gICAgICB2YXIgb3JkZXIgPSBnZXRPcmRlcihsaW5lKTtcbiAgICAgIGlmICghb3JkZXIgfHwgb3JkZXJbMF0ubGV2ZWwgPT0gMCkge1xuICAgICAgICB2YXIgZmlyc3ROb25XUyA9IE1hdGgubWF4KDAsIGxpbmUudGV4dC5zZWFyY2goL1xcUy8pKTtcbiAgICAgICAgdmFyIGluV1MgPSBjdXIubGluZSA9PSBzdGFydC5saW5lICYmIGN1ci5jaCA8PSBmaXJzdE5vbldTICYmIGN1ci5jaDtcbiAgICAgICAgY20uZXh0ZW5kU2VsZWN0aW9uKFBvcyhzdGFydC5saW5lLCBpbldTID8gMCA6IGZpcnN0Tm9uV1MpKTtcbiAgICAgIH0gZWxzZSBjbS5leHRlbmRTZWxlY3Rpb24oc3RhcnQpO1xuICAgIH0sXG4gICAgZ29MaW5lRW5kOiBmdW5jdGlvbihjbSkge1xuICAgICAgY20uZXh0ZW5kU2VsZWN0aW9uKGxpbmVFbmQoY20sIGNtLmdldEN1cnNvcigpLmxpbmUpKTtcbiAgICB9LFxuICAgIGdvTGluZVJpZ2h0OiBmdW5jdGlvbihjbSkge1xuICAgICAgdmFyIHRvcCA9IGNtLmNoYXJDb29yZHMoY20uZ2V0Q3Vyc29yKCksIFwiZGl2XCIpLnRvcCArIDU7XG4gICAgICBjbS5leHRlbmRTZWxlY3Rpb24oY20uY29vcmRzQ2hhcih7bGVmdDogY20uZGlzcGxheS5saW5lRGl2Lm9mZnNldFdpZHRoICsgMTAwLCB0b3A6IHRvcH0sIFwiZGl2XCIpKTtcbiAgICB9LFxuICAgIGdvTGluZUxlZnQ6IGZ1bmN0aW9uKGNtKSB7XG4gICAgICB2YXIgdG9wID0gY20uY2hhckNvb3JkcyhjbS5nZXRDdXJzb3IoKSwgXCJkaXZcIikudG9wICsgNTtcbiAgICAgIGNtLmV4dGVuZFNlbGVjdGlvbihjbS5jb29yZHNDaGFyKHtsZWZ0OiAwLCB0b3A6IHRvcH0sIFwiZGl2XCIpKTtcbiAgICB9LFxuICAgIGdvTGluZVVwOiBmdW5jdGlvbihjbSkge2NtLm1vdmVWKC0xLCBcImxpbmVcIik7fSxcbiAgICBnb0xpbmVEb3duOiBmdW5jdGlvbihjbSkge2NtLm1vdmVWKDEsIFwibGluZVwiKTt9LFxuICAgIGdvUGFnZVVwOiBmdW5jdGlvbihjbSkge2NtLm1vdmVWKC0xLCBcInBhZ2VcIik7fSxcbiAgICBnb1BhZ2VEb3duOiBmdW5jdGlvbihjbSkge2NtLm1vdmVWKDEsIFwicGFnZVwiKTt9LFxuICAgIGdvQ2hhckxlZnQ6IGZ1bmN0aW9uKGNtKSB7Y20ubW92ZUgoLTEsIFwiY2hhclwiKTt9LFxuICAgIGdvQ2hhclJpZ2h0OiBmdW5jdGlvbihjbSkge2NtLm1vdmVIKDEsIFwiY2hhclwiKTt9LFxuICAgIGdvQ29sdW1uTGVmdDogZnVuY3Rpb24oY20pIHtjbS5tb3ZlSCgtMSwgXCJjb2x1bW5cIik7fSxcbiAgICBnb0NvbHVtblJpZ2h0OiBmdW5jdGlvbihjbSkge2NtLm1vdmVIKDEsIFwiY29sdW1uXCIpO30sXG4gICAgZ29Xb3JkTGVmdDogZnVuY3Rpb24oY20pIHtjbS5tb3ZlSCgtMSwgXCJ3b3JkXCIpO30sXG4gICAgZ29Hcm91cFJpZ2h0OiBmdW5jdGlvbihjbSkge2NtLm1vdmVIKDEsIFwiZ3JvdXBcIik7fSxcbiAgICBnb0dyb3VwTGVmdDogZnVuY3Rpb24oY20pIHtjbS5tb3ZlSCgtMSwgXCJncm91cFwiKTt9LFxuICAgIGdvV29yZFJpZ2h0OiBmdW5jdGlvbihjbSkge2NtLm1vdmVIKDEsIFwid29yZFwiKTt9LFxuICAgIGRlbENoYXJCZWZvcmU6IGZ1bmN0aW9uKGNtKSB7Y20uZGVsZXRlSCgtMSwgXCJjaGFyXCIpO30sXG4gICAgZGVsQ2hhckFmdGVyOiBmdW5jdGlvbihjbSkge2NtLmRlbGV0ZUgoMSwgXCJjaGFyXCIpO30sXG4gICAgZGVsV29yZEJlZm9yZTogZnVuY3Rpb24oY20pIHtjbS5kZWxldGVIKC0xLCBcIndvcmRcIik7fSxcbiAgICBkZWxXb3JkQWZ0ZXI6IGZ1bmN0aW9uKGNtKSB7Y20uZGVsZXRlSCgxLCBcIndvcmRcIik7fSxcbiAgICBkZWxHcm91cEJlZm9yZTogZnVuY3Rpb24oY20pIHtjbS5kZWxldGVIKC0xLCBcImdyb3VwXCIpO30sXG4gICAgZGVsR3JvdXBBZnRlcjogZnVuY3Rpb24oY20pIHtjbS5kZWxldGVIKDEsIFwiZ3JvdXBcIik7fSxcbiAgICBpbmRlbnRBdXRvOiBmdW5jdGlvbihjbSkge2NtLmluZGVudFNlbGVjdGlvbihcInNtYXJ0XCIpO30sXG4gICAgaW5kZW50TW9yZTogZnVuY3Rpb24oY20pIHtjbS5pbmRlbnRTZWxlY3Rpb24oXCJhZGRcIik7fSxcbiAgICBpbmRlbnRMZXNzOiBmdW5jdGlvbihjbSkge2NtLmluZGVudFNlbGVjdGlvbihcInN1YnRyYWN0XCIpO30sXG4gICAgaW5zZXJ0VGFiOiBmdW5jdGlvbihjbSkge1xuICAgICAgY20ucmVwbGFjZVNlbGVjdGlvbihcIlxcdFwiLCBcImVuZFwiLCBcIitpbnB1dFwiKTtcbiAgICB9LFxuICAgIGRlZmF1bHRUYWI6IGZ1bmN0aW9uKGNtKSB7XG4gICAgICBpZiAoY20uc29tZXRoaW5nU2VsZWN0ZWQoKSkgY20uaW5kZW50U2VsZWN0aW9uKFwiYWRkXCIpO1xuICAgICAgZWxzZSBjbS5yZXBsYWNlU2VsZWN0aW9uKFwiXFx0XCIsIFwiZW5kXCIsIFwiK2lucHV0XCIpO1xuICAgIH0sXG4gICAgdHJhbnNwb3NlQ2hhcnM6IGZ1bmN0aW9uKGNtKSB7XG4gICAgICB2YXIgY3VyID0gY20uZ2V0Q3Vyc29yKCksIGxpbmUgPSBjbS5nZXRMaW5lKGN1ci5saW5lKTtcbiAgICAgIGlmIChjdXIuY2ggPiAwICYmIGN1ci5jaCA8IGxpbmUubGVuZ3RoIC0gMSlcbiAgICAgICAgY20ucmVwbGFjZVJhbmdlKGxpbmUuY2hhckF0KGN1ci5jaCkgKyBsaW5lLmNoYXJBdChjdXIuY2ggLSAxKSxcbiAgICAgICAgICAgICAgICAgICAgICAgIFBvcyhjdXIubGluZSwgY3VyLmNoIC0gMSksIFBvcyhjdXIubGluZSwgY3VyLmNoICsgMSkpO1xuICAgIH0sXG4gICAgbmV3bGluZUFuZEluZGVudDogZnVuY3Rpb24oY20pIHtcbiAgICAgIG9wZXJhdGlvbihjbSwgZnVuY3Rpb24oKSB7XG4gICAgICAgIGNtLnJlcGxhY2VTZWxlY3Rpb24oXCJcXG5cIiwgXCJlbmRcIiwgXCIraW5wdXRcIik7XG4gICAgICAgIGNtLmluZGVudExpbmUoY20uZ2V0Q3Vyc29yKCkubGluZSwgbnVsbCwgdHJ1ZSk7XG4gICAgICB9KSgpO1xuICAgIH0sXG4gICAgdG9nZ2xlT3ZlcndyaXRlOiBmdW5jdGlvbihjbSkge2NtLnRvZ2dsZU92ZXJ3cml0ZSgpO31cbiAgfTtcblxuICAvLyBTVEFOREFSRCBLRVlNQVBTXG5cbiAgdmFyIGtleU1hcCA9IENvZGVNaXJyb3Iua2V5TWFwID0ge307XG4gIGtleU1hcC5iYXNpYyA9IHtcbiAgICBcIkxlZnRcIjogXCJnb0NoYXJMZWZ0XCIsIFwiUmlnaHRcIjogXCJnb0NoYXJSaWdodFwiLCBcIlVwXCI6IFwiZ29MaW5lVXBcIiwgXCJEb3duXCI6IFwiZ29MaW5lRG93blwiLFxuICAgIFwiRW5kXCI6IFwiZ29MaW5lRW5kXCIsIFwiSG9tZVwiOiBcImdvTGluZVN0YXJ0U21hcnRcIiwgXCJQYWdlVXBcIjogXCJnb1BhZ2VVcFwiLCBcIlBhZ2VEb3duXCI6IFwiZ29QYWdlRG93blwiLFxuICAgIFwiRGVsZXRlXCI6IFwiZGVsQ2hhckFmdGVyXCIsIFwiQmFja3NwYWNlXCI6IFwiZGVsQ2hhckJlZm9yZVwiLCBcIlNoaWZ0LUJhY2tzcGFjZVwiOiBcImRlbENoYXJCZWZvcmVcIixcbiAgICBcIlRhYlwiOiBcImRlZmF1bHRUYWJcIiwgXCJTaGlmdC1UYWJcIjogXCJpbmRlbnRBdXRvXCIsXG4gICAgXCJFbnRlclwiOiBcIm5ld2xpbmVBbmRJbmRlbnRcIiwgXCJJbnNlcnRcIjogXCJ0b2dnbGVPdmVyd3JpdGVcIlxuICB9O1xuICAvLyBOb3RlIHRoYXQgdGhlIHNhdmUgYW5kIGZpbmQtcmVsYXRlZCBjb21tYW5kcyBhcmVuJ3QgZGVmaW5lZCBieVxuICAvLyBkZWZhdWx0LiBVbmtub3duIGNvbW1hbmRzIGFyZSBzaW1wbHkgaWdub3JlZC5cbiAga2V5TWFwLnBjRGVmYXVsdCA9IHtcbiAgICBcIkN0cmwtQVwiOiBcInNlbGVjdEFsbFwiLCBcIkN0cmwtRFwiOiBcImRlbGV0ZUxpbmVcIiwgXCJDdHJsLVpcIjogXCJ1bmRvXCIsIFwiU2hpZnQtQ3RybC1aXCI6IFwicmVkb1wiLCBcIkN0cmwtWVwiOiBcInJlZG9cIixcbiAgICBcIkN0cmwtSG9tZVwiOiBcImdvRG9jU3RhcnRcIiwgXCJDdHJsLVVwXCI6IFwiZ29Eb2NTdGFydFwiLCBcIkN0cmwtRW5kXCI6IFwiZ29Eb2NFbmRcIiwgXCJDdHJsLURvd25cIjogXCJnb0RvY0VuZFwiLFxuICAgIFwiQ3RybC1MZWZ0XCI6IFwiZ29Hcm91cExlZnRcIiwgXCJDdHJsLVJpZ2h0XCI6IFwiZ29Hcm91cFJpZ2h0XCIsIFwiQWx0LUxlZnRcIjogXCJnb0xpbmVTdGFydFwiLCBcIkFsdC1SaWdodFwiOiBcImdvTGluZUVuZFwiLFxuICAgIFwiQ3RybC1CYWNrc3BhY2VcIjogXCJkZWxHcm91cEJlZm9yZVwiLCBcIkN0cmwtRGVsZXRlXCI6IFwiZGVsR3JvdXBBZnRlclwiLCBcIkN0cmwtU1wiOiBcInNhdmVcIiwgXCJDdHJsLUZcIjogXCJmaW5kXCIsXG4gICAgXCJDdHJsLUdcIjogXCJmaW5kTmV4dFwiLCBcIlNoaWZ0LUN0cmwtR1wiOiBcImZpbmRQcmV2XCIsIFwiU2hpZnQtQ3RybC1GXCI6IFwicmVwbGFjZVwiLCBcIlNoaWZ0LUN0cmwtUlwiOiBcInJlcGxhY2VBbGxcIixcbiAgICBcIkN0cmwtW1wiOiBcImluZGVudExlc3NcIiwgXCJDdHJsLV1cIjogXCJpbmRlbnRNb3JlXCIsXG4gICAgZmFsbHRocm91Z2g6IFwiYmFzaWNcIlxuICB9O1xuICBrZXlNYXAubWFjRGVmYXVsdCA9IHtcbiAgICBcIkNtZC1BXCI6IFwic2VsZWN0QWxsXCIsIFwiQ21kLURcIjogXCJkZWxldGVMaW5lXCIsIFwiQ21kLVpcIjogXCJ1bmRvXCIsIFwiU2hpZnQtQ21kLVpcIjogXCJyZWRvXCIsIFwiQ21kLVlcIjogXCJyZWRvXCIsXG4gICAgXCJDbWQtVXBcIjogXCJnb0RvY1N0YXJ0XCIsIFwiQ21kLUVuZFwiOiBcImdvRG9jRW5kXCIsIFwiQ21kLURvd25cIjogXCJnb0RvY0VuZFwiLCBcIkFsdC1MZWZ0XCI6IFwiZ29Hcm91cExlZnRcIixcbiAgICBcIkFsdC1SaWdodFwiOiBcImdvR3JvdXBSaWdodFwiLCBcIkNtZC1MZWZ0XCI6IFwiZ29MaW5lU3RhcnRcIiwgXCJDbWQtUmlnaHRcIjogXCJnb0xpbmVFbmRcIiwgXCJBbHQtQmFja3NwYWNlXCI6IFwiZGVsR3JvdXBCZWZvcmVcIixcbiAgICBcIkN0cmwtQWx0LUJhY2tzcGFjZVwiOiBcImRlbEdyb3VwQWZ0ZXJcIiwgXCJBbHQtRGVsZXRlXCI6IFwiZGVsR3JvdXBBZnRlclwiLCBcIkNtZC1TXCI6IFwic2F2ZVwiLCBcIkNtZC1GXCI6IFwiZmluZFwiLFxuICAgIFwiQ21kLUdcIjogXCJmaW5kTmV4dFwiLCBcIlNoaWZ0LUNtZC1HXCI6IFwiZmluZFByZXZcIiwgXCJDbWQtQWx0LUZcIjogXCJyZXBsYWNlXCIsIFwiU2hpZnQtQ21kLUFsdC1GXCI6IFwicmVwbGFjZUFsbFwiLFxuICAgIFwiQ21kLVtcIjogXCJpbmRlbnRMZXNzXCIsIFwiQ21kLV1cIjogXCJpbmRlbnRNb3JlXCIsIFwiQ21kLUJhY2tzcGFjZVwiOiBcImRlbExpbmVMZWZ0XCIsXG4gICAgZmFsbHRocm91Z2g6IFtcImJhc2ljXCIsIFwiZW1hY3N5XCJdXG4gIH07XG4gIGtleU1hcFtcImRlZmF1bHRcIl0gPSBtYWMgPyBrZXlNYXAubWFjRGVmYXVsdCA6IGtleU1hcC5wY0RlZmF1bHQ7XG4gIGtleU1hcC5lbWFjc3kgPSB7XG4gICAgXCJDdHJsLUZcIjogXCJnb0NoYXJSaWdodFwiLCBcIkN0cmwtQlwiOiBcImdvQ2hhckxlZnRcIiwgXCJDdHJsLVBcIjogXCJnb0xpbmVVcFwiLCBcIkN0cmwtTlwiOiBcImdvTGluZURvd25cIixcbiAgICBcIkFsdC1GXCI6IFwiZ29Xb3JkUmlnaHRcIiwgXCJBbHQtQlwiOiBcImdvV29yZExlZnRcIiwgXCJDdHJsLUFcIjogXCJnb0xpbmVTdGFydFwiLCBcIkN0cmwtRVwiOiBcImdvTGluZUVuZFwiLFxuICAgIFwiQ3RybC1WXCI6IFwiZ29QYWdlRG93blwiLCBcIlNoaWZ0LUN0cmwtVlwiOiBcImdvUGFnZVVwXCIsIFwiQ3RybC1EXCI6IFwiZGVsQ2hhckFmdGVyXCIsIFwiQ3RybC1IXCI6IFwiZGVsQ2hhckJlZm9yZVwiLFxuICAgIFwiQWx0LURcIjogXCJkZWxXb3JkQWZ0ZXJcIiwgXCJBbHQtQmFja3NwYWNlXCI6IFwiZGVsV29yZEJlZm9yZVwiLCBcIkN0cmwtS1wiOiBcImtpbGxMaW5lXCIsIFwiQ3RybC1UXCI6IFwidHJhbnNwb3NlQ2hhcnNcIlxuICB9O1xuXG4gIC8vIEtFWU1BUCBESVNQQVRDSFxuXG4gIGZ1bmN0aW9uIGdldEtleU1hcCh2YWwpIHtcbiAgICBpZiAodHlwZW9mIHZhbCA9PSBcInN0cmluZ1wiKSByZXR1cm4ga2V5TWFwW3ZhbF07XG4gICAgZWxzZSByZXR1cm4gdmFsO1xuICB9XG5cbiAgZnVuY3Rpb24gbG9va3VwS2V5KG5hbWUsIG1hcHMsIGhhbmRsZSkge1xuICAgIGZ1bmN0aW9uIGxvb2t1cChtYXApIHtcbiAgICAgIG1hcCA9IGdldEtleU1hcChtYXApO1xuICAgICAgdmFyIGZvdW5kID0gbWFwW25hbWVdO1xuICAgICAgaWYgKGZvdW5kID09PSBmYWxzZSkgcmV0dXJuIFwic3RvcFwiO1xuICAgICAgaWYgKGZvdW5kICE9IG51bGwgJiYgaGFuZGxlKGZvdW5kKSkgcmV0dXJuIHRydWU7XG4gICAgICBpZiAobWFwLm5vZmFsbHRocm91Z2gpIHJldHVybiBcInN0b3BcIjtcblxuICAgICAgdmFyIGZhbGx0aHJvdWdoID0gbWFwLmZhbGx0aHJvdWdoO1xuICAgICAgaWYgKGZhbGx0aHJvdWdoID09IG51bGwpIHJldHVybiBmYWxzZTtcbiAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwoZmFsbHRocm91Z2gpICE9IFwiW29iamVjdCBBcnJheV1cIilcbiAgICAgICAgcmV0dXJuIGxvb2t1cChmYWxsdGhyb3VnaCk7XG4gICAgICBmb3IgKHZhciBpID0gMCwgZSA9IGZhbGx0aHJvdWdoLmxlbmd0aDsgaSA8IGU7ICsraSkge1xuICAgICAgICB2YXIgZG9uZSA9IGxvb2t1cChmYWxsdGhyb3VnaFtpXSk7XG4gICAgICAgIGlmIChkb25lKSByZXR1cm4gZG9uZTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IG1hcHMubGVuZ3RoOyArK2kpIHtcbiAgICAgIHZhciBkb25lID0gbG9va3VwKG1hcHNbaV0pO1xuICAgICAgaWYgKGRvbmUpIHJldHVybiBkb25lICE9IFwic3RvcFwiO1xuICAgIH1cbiAgfVxuICBmdW5jdGlvbiBpc01vZGlmaWVyS2V5KGV2ZW50KSB7XG4gICAgdmFyIG5hbWUgPSBrZXlOYW1lc1tldmVudC5rZXlDb2RlXTtcbiAgICByZXR1cm4gbmFtZSA9PSBcIkN0cmxcIiB8fCBuYW1lID09IFwiQWx0XCIgfHwgbmFtZSA9PSBcIlNoaWZ0XCIgfHwgbmFtZSA9PSBcIk1vZFwiO1xuICB9XG4gIGZ1bmN0aW9uIGtleU5hbWUoZXZlbnQsIG5vU2hpZnQpIHtcbiAgICBpZiAob3BlcmEgJiYgZXZlbnQua2V5Q29kZSA9PSAzNCAmJiBldmVudFtcImNoYXJcIl0pIHJldHVybiBmYWxzZTtcbiAgICB2YXIgbmFtZSA9IGtleU5hbWVzW2V2ZW50LmtleUNvZGVdO1xuICAgIGlmIChuYW1lID09IG51bGwgfHwgZXZlbnQuYWx0R3JhcGhLZXkpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoZXZlbnQuYWx0S2V5KSBuYW1lID0gXCJBbHQtXCIgKyBuYW1lO1xuICAgIGlmIChmbGlwQ3RybENtZCA/IGV2ZW50Lm1ldGFLZXkgOiBldmVudC5jdHJsS2V5KSBuYW1lID0gXCJDdHJsLVwiICsgbmFtZTtcbiAgICBpZiAoZmxpcEN0cmxDbWQgPyBldmVudC5jdHJsS2V5IDogZXZlbnQubWV0YUtleSkgbmFtZSA9IFwiQ21kLVwiICsgbmFtZTtcbiAgICBpZiAoIW5vU2hpZnQgJiYgZXZlbnQuc2hpZnRLZXkpIG5hbWUgPSBcIlNoaWZ0LVwiICsgbmFtZTtcbiAgICByZXR1cm4gbmFtZTtcbiAgfVxuICBDb2RlTWlycm9yLmxvb2t1cEtleSA9IGxvb2t1cEtleTtcbiAgQ29kZU1pcnJvci5pc01vZGlmaWVyS2V5ID0gaXNNb2RpZmllcktleTtcbiAgQ29kZU1pcnJvci5rZXlOYW1lID0ga2V5TmFtZTtcblxuICAvLyBGUk9NVEVYVEFSRUFcblxuICBDb2RlTWlycm9yLmZyb21UZXh0QXJlYSA9IGZ1bmN0aW9uKHRleHRhcmVhLCBvcHRpb25zKSB7XG4gICAgaWYgKCFvcHRpb25zKSBvcHRpb25zID0ge307XG4gICAgb3B0aW9ucy52YWx1ZSA9IHRleHRhcmVhLnZhbHVlO1xuICAgIGlmICghb3B0aW9ucy50YWJpbmRleCAmJiB0ZXh0YXJlYS50YWJpbmRleClcbiAgICAgIG9wdGlvbnMudGFiaW5kZXggPSB0ZXh0YXJlYS50YWJpbmRleDtcbiAgICBpZiAoIW9wdGlvbnMucGxhY2Vob2xkZXIgJiYgdGV4dGFyZWEucGxhY2Vob2xkZXIpXG4gICAgICBvcHRpb25zLnBsYWNlaG9sZGVyID0gdGV4dGFyZWEucGxhY2Vob2xkZXI7XG4gICAgLy8gU2V0IGF1dG9mb2N1cyB0byB0cnVlIGlmIHRoaXMgdGV4dGFyZWEgaXMgZm9jdXNlZCwgb3IgaWYgaXQgaGFzXG4gICAgLy8gYXV0b2ZvY3VzIGFuZCBubyBvdGhlciBlbGVtZW50IGlzIGZvY3VzZWQuXG4gICAgaWYgKG9wdGlvbnMuYXV0b2ZvY3VzID09IG51bGwpIHtcbiAgICAgIHZhciBoYXNGb2N1cyA9IGRvY3VtZW50LmJvZHk7XG4gICAgICAvLyBkb2MuYWN0aXZlRWxlbWVudCBvY2Nhc2lvbmFsbHkgdGhyb3dzIG9uIElFXG4gICAgICB0cnkgeyBoYXNGb2N1cyA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQ7IH0gY2F0Y2goZSkge31cbiAgICAgIG9wdGlvbnMuYXV0b2ZvY3VzID0gaGFzRm9jdXMgPT0gdGV4dGFyZWEgfHxcbiAgICAgICAgdGV4dGFyZWEuZ2V0QXR0cmlidXRlKFwiYXV0b2ZvY3VzXCIpICE9IG51bGwgJiYgaGFzRm9jdXMgPT0gZG9jdW1lbnQuYm9keTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBzYXZlKCkge3RleHRhcmVhLnZhbHVlID0gY20uZ2V0VmFsdWUoKTt9XG4gICAgaWYgKHRleHRhcmVhLmZvcm0pIHtcbiAgICAgIG9uKHRleHRhcmVhLmZvcm0sIFwic3VibWl0XCIsIHNhdmUpO1xuICAgICAgLy8gRGVwbG9yYWJsZSBoYWNrIHRvIG1ha2UgdGhlIHN1Ym1pdCBtZXRob2QgZG8gdGhlIHJpZ2h0IHRoaW5nLlxuICAgICAgaWYgKCFvcHRpb25zLmxlYXZlU3VibWl0TWV0aG9kQWxvbmUpIHtcbiAgICAgICAgdmFyIGZvcm0gPSB0ZXh0YXJlYS5mb3JtLCByZWFsU3VibWl0ID0gZm9ybS5zdWJtaXQ7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgdmFyIHdyYXBwZWRTdWJtaXQgPSBmb3JtLnN1Ym1pdCA9IGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgc2F2ZSgpO1xuICAgICAgICAgICAgZm9ybS5zdWJtaXQgPSByZWFsU3VibWl0O1xuICAgICAgICAgICAgZm9ybS5zdWJtaXQoKTtcbiAgICAgICAgICAgIGZvcm0uc3VibWl0ID0gd3JhcHBlZFN1Ym1pdDtcbiAgICAgICAgICB9O1xuICAgICAgICB9IGNhdGNoKGUpIHt9XG4gICAgICB9XG4gICAgfVxuXG4gICAgdGV4dGFyZWEuc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICAgIHZhciBjbSA9IENvZGVNaXJyb3IoZnVuY3Rpb24obm9kZSkge1xuICAgICAgdGV4dGFyZWEucGFyZW50Tm9kZS5pbnNlcnRCZWZvcmUobm9kZSwgdGV4dGFyZWEubmV4dFNpYmxpbmcpO1xuICAgIH0sIG9wdGlvbnMpO1xuICAgIGNtLnNhdmUgPSBzYXZlO1xuICAgIGNtLmdldFRleHRBcmVhID0gZnVuY3Rpb24oKSB7IHJldHVybiB0ZXh0YXJlYTsgfTtcbiAgICBjbS50b1RleHRBcmVhID0gZnVuY3Rpb24oKSB7XG4gICAgICBzYXZlKCk7XG4gICAgICB0ZXh0YXJlYS5wYXJlbnROb2RlLnJlbW92ZUNoaWxkKGNtLmdldFdyYXBwZXJFbGVtZW50KCkpO1xuICAgICAgdGV4dGFyZWEuc3R5bGUuZGlzcGxheSA9IFwiXCI7XG4gICAgICBpZiAodGV4dGFyZWEuZm9ybSkge1xuICAgICAgICBvZmYodGV4dGFyZWEuZm9ybSwgXCJzdWJtaXRcIiwgc2F2ZSk7XG4gICAgICAgIGlmICh0eXBlb2YgdGV4dGFyZWEuZm9ybS5zdWJtaXQgPT0gXCJmdW5jdGlvblwiKVxuICAgICAgICAgIHRleHRhcmVhLmZvcm0uc3VibWl0ID0gcmVhbFN1Ym1pdDtcbiAgICAgIH1cbiAgICB9O1xuICAgIHJldHVybiBjbTtcbiAgfTtcblxuICAvLyBTVFJJTkcgU1RSRUFNXG5cbiAgLy8gRmVkIHRvIHRoZSBtb2RlIHBhcnNlcnMsIHByb3ZpZGVzIGhlbHBlciBmdW5jdGlvbnMgdG8gbWFrZVxuICAvLyBwYXJzZXJzIG1vcmUgc3VjY2luY3QuXG5cbiAgLy8gVGhlIGNoYXJhY3RlciBzdHJlYW0gdXNlZCBieSBhIG1vZGUncyBwYXJzZXIuXG4gIGZ1bmN0aW9uIFN0cmluZ1N0cmVhbShzdHJpbmcsIHRhYlNpemUpIHtcbiAgICB0aGlzLnBvcyA9IHRoaXMuc3RhcnQgPSAwO1xuICAgIHRoaXMuc3RyaW5nID0gc3RyaW5nO1xuICAgIHRoaXMudGFiU2l6ZSA9IHRhYlNpemUgfHwgODtcbiAgICB0aGlzLmxhc3RDb2x1bW5Qb3MgPSB0aGlzLmxhc3RDb2x1bW5WYWx1ZSA9IDA7XG4gICAgdGhpcy5saW5lU3RhcnQgPSAwO1xuICB9XG5cbiAgU3RyaW5nU3RyZWFtLnByb3RvdHlwZSA9IHtcbiAgICBlb2w6IGZ1bmN0aW9uKCkge3JldHVybiB0aGlzLnBvcyA+PSB0aGlzLnN0cmluZy5sZW5ndGg7fSxcbiAgICBzb2w6IGZ1bmN0aW9uKCkge3JldHVybiB0aGlzLnBvcyA9PSB0aGlzLmxpbmVTdGFydDt9LFxuICAgIHBlZWs6IGZ1bmN0aW9uKCkge3JldHVybiB0aGlzLnN0cmluZy5jaGFyQXQodGhpcy5wb3MpIHx8IHVuZGVmaW5lZDt9LFxuICAgIG5leHQ6IGZ1bmN0aW9uKCkge1xuICAgICAgaWYgKHRoaXMucG9zIDwgdGhpcy5zdHJpbmcubGVuZ3RoKVxuICAgICAgICByZXR1cm4gdGhpcy5zdHJpbmcuY2hhckF0KHRoaXMucG9zKyspO1xuICAgIH0sXG4gICAgZWF0OiBmdW5jdGlvbihtYXRjaCkge1xuICAgICAgdmFyIGNoID0gdGhpcy5zdHJpbmcuY2hhckF0KHRoaXMucG9zKTtcbiAgICAgIGlmICh0eXBlb2YgbWF0Y2ggPT0gXCJzdHJpbmdcIikgdmFyIG9rID0gY2ggPT0gbWF0Y2g7XG4gICAgICBlbHNlIHZhciBvayA9IGNoICYmIChtYXRjaC50ZXN0ID8gbWF0Y2gudGVzdChjaCkgOiBtYXRjaChjaCkpO1xuICAgICAgaWYgKG9rKSB7Kyt0aGlzLnBvczsgcmV0dXJuIGNoO31cbiAgICB9LFxuICAgIGVhdFdoaWxlOiBmdW5jdGlvbihtYXRjaCkge1xuICAgICAgdmFyIHN0YXJ0ID0gdGhpcy5wb3M7XG4gICAgICB3aGlsZSAodGhpcy5lYXQobWF0Y2gpKXt9XG4gICAgICByZXR1cm4gdGhpcy5wb3MgPiBzdGFydDtcbiAgICB9LFxuICAgIGVhdFNwYWNlOiBmdW5jdGlvbigpIHtcbiAgICAgIHZhciBzdGFydCA9IHRoaXMucG9zO1xuICAgICAgd2hpbGUgKC9bXFxzXFx1MDBhMF0vLnRlc3QodGhpcy5zdHJpbmcuY2hhckF0KHRoaXMucG9zKSkpICsrdGhpcy5wb3M7XG4gICAgICByZXR1cm4gdGhpcy5wb3MgPiBzdGFydDtcbiAgICB9LFxuICAgIHNraXBUb0VuZDogZnVuY3Rpb24oKSB7dGhpcy5wb3MgPSB0aGlzLnN0cmluZy5sZW5ndGg7fSxcbiAgICBza2lwVG86IGZ1bmN0aW9uKGNoKSB7XG4gICAgICB2YXIgZm91bmQgPSB0aGlzLnN0cmluZy5pbmRleE9mKGNoLCB0aGlzLnBvcyk7XG4gICAgICBpZiAoZm91bmQgPiAtMSkge3RoaXMucG9zID0gZm91bmQ7IHJldHVybiB0cnVlO31cbiAgICB9LFxuICAgIGJhY2tVcDogZnVuY3Rpb24obikge3RoaXMucG9zIC09IG47fSxcbiAgICBjb2x1bW46IGZ1bmN0aW9uKCkge1xuICAgICAgaWYgKHRoaXMubGFzdENvbHVtblBvcyA8IHRoaXMuc3RhcnQpIHtcbiAgICAgICAgdGhpcy5sYXN0Q29sdW1uVmFsdWUgPSBjb3VudENvbHVtbih0aGlzLnN0cmluZywgdGhpcy5zdGFydCwgdGhpcy50YWJTaXplLCB0aGlzLmxhc3RDb2x1bW5Qb3MsIHRoaXMubGFzdENvbHVtblZhbHVlKTtcbiAgICAgICAgdGhpcy5sYXN0Q29sdW1uUG9zID0gdGhpcy5zdGFydDtcbiAgICAgIH1cbiAgICAgIHJldHVybiB0aGlzLmxhc3RDb2x1bW5WYWx1ZSAtICh0aGlzLmxpbmVTdGFydCA/IGNvdW50Q29sdW1uKHRoaXMuc3RyaW5nLCB0aGlzLmxpbmVTdGFydCwgdGhpcy50YWJTaXplKSA6IDApO1xuICAgIH0sXG4gICAgaW5kZW50YXRpb246IGZ1bmN0aW9uKCkge1xuICAgICAgcmV0dXJuIGNvdW50Q29sdW1uKHRoaXMuc3RyaW5nLCBudWxsLCB0aGlzLnRhYlNpemUpIC1cbiAgICAgICAgKHRoaXMubGluZVN0YXJ0ID8gY291bnRDb2x1bW4odGhpcy5zdHJpbmcsIHRoaXMubGluZVN0YXJ0LCB0aGlzLnRhYlNpemUpIDogMCk7XG4gICAgfSxcbiAgICBtYXRjaDogZnVuY3Rpb24ocGF0dGVybiwgY29uc3VtZSwgY2FzZUluc2Vuc2l0aXZlKSB7XG4gICAgICBpZiAodHlwZW9mIHBhdHRlcm4gPT0gXCJzdHJpbmdcIikge1xuICAgICAgICB2YXIgY2FzZWQgPSBmdW5jdGlvbihzdHIpIHtyZXR1cm4gY2FzZUluc2Vuc2l0aXZlID8gc3RyLnRvTG93ZXJDYXNlKCkgOiBzdHI7fTtcbiAgICAgICAgdmFyIHN1YnN0ciA9IHRoaXMuc3RyaW5nLnN1YnN0cih0aGlzLnBvcywgcGF0dGVybi5sZW5ndGgpO1xuICAgICAgICBpZiAoY2FzZWQoc3Vic3RyKSA9PSBjYXNlZChwYXR0ZXJuKSkge1xuICAgICAgICAgIGlmIChjb25zdW1lICE9PSBmYWxzZSkgdGhpcy5wb3MgKz0gcGF0dGVybi5sZW5ndGg7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHZhciBtYXRjaCA9IHRoaXMuc3RyaW5nLnNsaWNlKHRoaXMucG9zKS5tYXRjaChwYXR0ZXJuKTtcbiAgICAgICAgaWYgKG1hdGNoICYmIG1hdGNoLmluZGV4ID4gMCkgcmV0dXJuIG51bGw7XG4gICAgICAgIGlmIChtYXRjaCAmJiBjb25zdW1lICE9PSBmYWxzZSkgdGhpcy5wb3MgKz0gbWF0Y2hbMF0ubGVuZ3RoO1xuICAgICAgICByZXR1cm4gbWF0Y2g7XG4gICAgICB9XG4gICAgfSxcbiAgICBjdXJyZW50OiBmdW5jdGlvbigpe3JldHVybiB0aGlzLnN0cmluZy5zbGljZSh0aGlzLnN0YXJ0LCB0aGlzLnBvcyk7fSxcbiAgICBoaWRlRmlyc3RDaGFyczogZnVuY3Rpb24obiwgaW5uZXIpIHtcbiAgICAgIHRoaXMubGluZVN0YXJ0ICs9IG47XG4gICAgICB0cnkgeyByZXR1cm4gaW5uZXIoKTsgfVxuICAgICAgZmluYWxseSB7IHRoaXMubGluZVN0YXJ0IC09IG47IH1cbiAgICB9XG4gIH07XG4gIENvZGVNaXJyb3IuU3RyaW5nU3RyZWFtID0gU3RyaW5nU3RyZWFtO1xuXG4gIC8vIFRFWFRNQVJLRVJTXG5cbiAgZnVuY3Rpb24gVGV4dE1hcmtlcihkb2MsIHR5cGUpIHtcbiAgICB0aGlzLmxpbmVzID0gW107XG4gICAgdGhpcy50eXBlID0gdHlwZTtcbiAgICB0aGlzLmRvYyA9IGRvYztcbiAgfVxuICBDb2RlTWlycm9yLlRleHRNYXJrZXIgPSBUZXh0TWFya2VyO1xuICBldmVudE1peGluKFRleHRNYXJrZXIpO1xuXG4gIFRleHRNYXJrZXIucHJvdG90eXBlLmNsZWFyID0gZnVuY3Rpb24oKSB7XG4gICAgaWYgKHRoaXMuZXhwbGljaXRseUNsZWFyZWQpIHJldHVybjtcbiAgICB2YXIgY20gPSB0aGlzLmRvYy5jbSwgd2l0aE9wID0gY20gJiYgIWNtLmN1ck9wO1xuICAgIGlmICh3aXRoT3ApIHN0YXJ0T3BlcmF0aW9uKGNtKTtcbiAgICBpZiAoaGFzSGFuZGxlcih0aGlzLCBcImNsZWFyXCIpKSB7XG4gICAgICB2YXIgZm91bmQgPSB0aGlzLmZpbmQoKTtcbiAgICAgIGlmIChmb3VuZCkgc2lnbmFsTGF0ZXIodGhpcywgXCJjbGVhclwiLCBmb3VuZC5mcm9tLCBmb3VuZC50byk7XG4gICAgfVxuICAgIHZhciBtaW4gPSBudWxsLCBtYXggPSBudWxsO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdGhpcy5saW5lcy5sZW5ndGg7ICsraSkge1xuICAgICAgdmFyIGxpbmUgPSB0aGlzLmxpbmVzW2ldO1xuICAgICAgdmFyIHNwYW4gPSBnZXRNYXJrZWRTcGFuRm9yKGxpbmUubWFya2VkU3BhbnMsIHRoaXMpO1xuICAgICAgaWYgKHNwYW4udG8gIT0gbnVsbCkgbWF4ID0gbGluZU5vKGxpbmUpO1xuICAgICAgbGluZS5tYXJrZWRTcGFucyA9IHJlbW92ZU1hcmtlZFNwYW4obGluZS5tYXJrZWRTcGFucywgc3Bhbik7XG4gICAgICBpZiAoc3Bhbi5mcm9tICE9IG51bGwpXG4gICAgICAgIG1pbiA9IGxpbmVObyhsaW5lKTtcbiAgICAgIGVsc2UgaWYgKHRoaXMuY29sbGFwc2VkICYmICFsaW5lSXNIaWRkZW4odGhpcy5kb2MsIGxpbmUpICYmIGNtKVxuICAgICAgICB1cGRhdGVMaW5lSGVpZ2h0KGxpbmUsIHRleHRIZWlnaHQoY20uZGlzcGxheSkpO1xuICAgIH1cbiAgICBpZiAoY20gJiYgdGhpcy5jb2xsYXBzZWQgJiYgIWNtLm9wdGlvbnMubGluZVdyYXBwaW5nKSBmb3IgKHZhciBpID0gMDsgaSA8IHRoaXMubGluZXMubGVuZ3RoOyArK2kpIHtcbiAgICAgIHZhciB2aXN1YWwgPSB2aXN1YWxMaW5lKGNtLmRvYywgdGhpcy5saW5lc1tpXSksIGxlbiA9IGxpbmVMZW5ndGgoY20uZG9jLCB2aXN1YWwpO1xuICAgICAgaWYgKGxlbiA+IGNtLmRpc3BsYXkubWF4TGluZUxlbmd0aCkge1xuICAgICAgICBjbS5kaXNwbGF5Lm1heExpbmUgPSB2aXN1YWw7XG4gICAgICAgIGNtLmRpc3BsYXkubWF4TGluZUxlbmd0aCA9IGxlbjtcbiAgICAgICAgY20uZGlzcGxheS5tYXhMaW5lQ2hhbmdlZCA9IHRydWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKG1pbiAhPSBudWxsICYmIGNtKSByZWdDaGFuZ2UoY20sIG1pbiwgbWF4ICsgMSk7XG4gICAgdGhpcy5saW5lcy5sZW5ndGggPSAwO1xuICAgIHRoaXMuZXhwbGljaXRseUNsZWFyZWQgPSB0cnVlO1xuICAgIGlmICh0aGlzLmF0b21pYyAmJiB0aGlzLmRvYy5jYW50RWRpdCkge1xuICAgICAgdGhpcy5kb2MuY2FudEVkaXQgPSBmYWxzZTtcbiAgICAgIGlmIChjbSkgcmVDaGVja1NlbGVjdGlvbihjbSk7XG4gICAgfVxuICAgIGlmICh3aXRoT3ApIGVuZE9wZXJhdGlvbihjbSk7XG4gIH07XG5cbiAgVGV4dE1hcmtlci5wcm90b3R5cGUuZmluZCA9IGZ1bmN0aW9uKGJvdGhTaWRlcykge1xuICAgIHZhciBmcm9tLCB0bztcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHRoaXMubGluZXMubGVuZ3RoOyArK2kpIHtcbiAgICAgIHZhciBsaW5lID0gdGhpcy5saW5lc1tpXTtcbiAgICAgIHZhciBzcGFuID0gZ2V0TWFya2VkU3BhbkZvcihsaW5lLm1hcmtlZFNwYW5zLCB0aGlzKTtcbiAgICAgIGlmIChzcGFuLmZyb20gIT0gbnVsbCB8fCBzcGFuLnRvICE9IG51bGwpIHtcbiAgICAgICAgdmFyIGZvdW5kID0gbGluZU5vKGxpbmUpO1xuICAgICAgICBpZiAoc3Bhbi5mcm9tICE9IG51bGwpIGZyb20gPSBQb3MoZm91bmQsIHNwYW4uZnJvbSk7XG4gICAgICAgIGlmIChzcGFuLnRvICE9IG51bGwpIHRvID0gUG9zKGZvdW5kLCBzcGFuLnRvKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHRoaXMudHlwZSA9PSBcImJvb2ttYXJrXCIgJiYgIWJvdGhTaWRlcykgcmV0dXJuIGZyb207XG4gICAgcmV0dXJuIGZyb20gJiYge2Zyb206IGZyb20sIHRvOiB0b307XG4gIH07XG5cbiAgVGV4dE1hcmtlci5wcm90b3R5cGUuY2hhbmdlZCA9IGZ1bmN0aW9uKCkge1xuICAgIHZhciBwb3MgPSB0aGlzLmZpbmQoKSwgY20gPSB0aGlzLmRvYy5jbTtcbiAgICBpZiAoIXBvcyB8fCAhY20pIHJldHVybjtcbiAgICBpZiAodGhpcy50eXBlICE9IFwiYm9va21hcmtcIikgcG9zID0gcG9zLmZyb207XG4gICAgdmFyIGxpbmUgPSBnZXRMaW5lKHRoaXMuZG9jLCBwb3MubGluZSk7XG4gICAgY2xlYXJDYWNoZWRNZWFzdXJlbWVudChjbSwgbGluZSk7XG4gICAgaWYgKHBvcy5saW5lID49IGNtLmRpc3BsYXkuc2hvd2luZ0Zyb20gJiYgcG9zLmxpbmUgPCBjbS5kaXNwbGF5LnNob3dpbmdUbykge1xuICAgICAgZm9yICh2YXIgbm9kZSA9IGNtLmRpc3BsYXkubGluZURpdi5maXJzdENoaWxkOyBub2RlOyBub2RlID0gbm9kZS5uZXh0U2libGluZykgaWYgKG5vZGUubGluZU9iaiA9PSBsaW5lKSB7XG4gICAgICAgIGlmIChub2RlLm9mZnNldEhlaWdodCAhPSBsaW5lLmhlaWdodCkgdXBkYXRlTGluZUhlaWdodChsaW5lLCBub2RlLm9mZnNldEhlaWdodCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgcnVuSW5PcChjbSwgZnVuY3Rpb24oKSB7XG4gICAgICAgIGNtLmN1ck9wLnNlbGVjdGlvbkNoYW5nZWQgPSBjbS5jdXJPcC5mb3JjZVVwZGF0ZSA9IGNtLmN1ck9wLnVwZGF0ZU1heExpbmUgPSB0cnVlO1xuICAgICAgfSk7XG4gICAgfVxuICB9O1xuXG4gIFRleHRNYXJrZXIucHJvdG90eXBlLmF0dGFjaExpbmUgPSBmdW5jdGlvbihsaW5lKSB7XG4gICAgaWYgKCF0aGlzLmxpbmVzLmxlbmd0aCAmJiB0aGlzLmRvYy5jbSkge1xuICAgICAgdmFyIG9wID0gdGhpcy5kb2MuY20uY3VyT3A7XG4gICAgICBpZiAoIW9wLm1heWJlSGlkZGVuTWFya2VycyB8fCBpbmRleE9mKG9wLm1heWJlSGlkZGVuTWFya2VycywgdGhpcykgPT0gLTEpXG4gICAgICAgIChvcC5tYXliZVVuaGlkZGVuTWFya2VycyB8fCAob3AubWF5YmVVbmhpZGRlbk1hcmtlcnMgPSBbXSkpLnB1c2godGhpcyk7XG4gICAgfVxuICAgIHRoaXMubGluZXMucHVzaChsaW5lKTtcbiAgfTtcbiAgVGV4dE1hcmtlci5wcm90b3R5cGUuZGV0YWNoTGluZSA9IGZ1bmN0aW9uKGxpbmUpIHtcbiAgICB0aGlzLmxpbmVzLnNwbGljZShpbmRleE9mKHRoaXMubGluZXMsIGxpbmUpLCAxKTtcbiAgICBpZiAoIXRoaXMubGluZXMubGVuZ3RoICYmIHRoaXMuZG9jLmNtKSB7XG4gICAgICB2YXIgb3AgPSB0aGlzLmRvYy5jbS5jdXJPcDtcbiAgICAgIChvcC5tYXliZUhpZGRlbk1hcmtlcnMgfHwgKG9wLm1heWJlSGlkZGVuTWFya2VycyA9IFtdKSkucHVzaCh0aGlzKTtcbiAgICB9XG4gIH07XG5cbiAgdmFyIG5leHRNYXJrZXJJZCA9IDA7XG5cbiAgZnVuY3Rpb24gbWFya1RleHQoZG9jLCBmcm9tLCB0bywgb3B0aW9ucywgdHlwZSkge1xuICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMuc2hhcmVkKSByZXR1cm4gbWFya1RleHRTaGFyZWQoZG9jLCBmcm9tLCB0bywgb3B0aW9ucywgdHlwZSk7XG4gICAgaWYgKGRvYy5jbSAmJiAhZG9jLmNtLmN1ck9wKSByZXR1cm4gb3BlcmF0aW9uKGRvYy5jbSwgbWFya1RleHQpKGRvYywgZnJvbSwgdG8sIG9wdGlvbnMsIHR5cGUpO1xuXG4gICAgdmFyIG1hcmtlciA9IG5ldyBUZXh0TWFya2VyKGRvYywgdHlwZSk7XG4gICAgaWYgKG9wdGlvbnMpIGNvcHlPYmoob3B0aW9ucywgbWFya2VyKTtcbiAgICBpZiAocG9zTGVzcyh0bywgZnJvbSkgfHwgcG9zRXEoZnJvbSwgdG8pICYmIG1hcmtlci5jbGVhcldoZW5FbXB0eSAhPT0gZmFsc2UpXG4gICAgICByZXR1cm4gbWFya2VyO1xuICAgIGlmIChtYXJrZXIucmVwbGFjZWRXaXRoKSB7XG4gICAgICBtYXJrZXIuY29sbGFwc2VkID0gdHJ1ZTtcbiAgICAgIG1hcmtlci5yZXBsYWNlZFdpdGggPSBlbHQoXCJzcGFuXCIsIFttYXJrZXIucmVwbGFjZWRXaXRoXSwgXCJDb2RlTWlycm9yLXdpZGdldFwiKTtcbiAgICAgIGlmICghb3B0aW9ucy5oYW5kbGVNb3VzZUV2ZW50cykgbWFya2VyLnJlcGxhY2VkV2l0aC5pZ25vcmVFdmVudHMgPSB0cnVlO1xuICAgIH1cbiAgICBpZiAobWFya2VyLmNvbGxhcHNlZCkge1xuICAgICAgaWYgKGNvbmZsaWN0aW5nQ29sbGFwc2VkUmFuZ2UoZG9jLCBmcm9tLmxpbmUsIGZyb20sIHRvLCBtYXJrZXIpIHx8XG4gICAgICAgICAgZnJvbS5saW5lICE9IHRvLmxpbmUgJiYgY29uZmxpY3RpbmdDb2xsYXBzZWRSYW5nZShkb2MsIHRvLmxpbmUsIGZyb20sIHRvLCBtYXJrZXIpKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJJbnNlcnRpbmcgY29sbGFwc2VkIG1hcmtlciBwYXJ0aWFsbHkgb3ZlcmxhcHBpbmcgYW4gZXhpc3Rpbmcgb25lXCIpO1xuICAgICAgc2F3Q29sbGFwc2VkU3BhbnMgPSB0cnVlO1xuICAgIH1cblxuICAgIGlmIChtYXJrZXIuYWRkVG9IaXN0b3J5KVxuICAgICAgYWRkVG9IaXN0b3J5KGRvYywge2Zyb206IGZyb20sIHRvOiB0bywgb3JpZ2luOiBcIm1hcmtUZXh0XCJ9LFxuICAgICAgICAgICAgICAgICAgIHtoZWFkOiBkb2Muc2VsLmhlYWQsIGFuY2hvcjogZG9jLnNlbC5hbmNob3J9LCBOYU4pO1xuXG4gICAgdmFyIGN1ckxpbmUgPSBmcm9tLmxpbmUsIGNtID0gZG9jLmNtLCB1cGRhdGVNYXhMaW5lO1xuICAgIGRvYy5pdGVyKGN1ckxpbmUsIHRvLmxpbmUgKyAxLCBmdW5jdGlvbihsaW5lKSB7XG4gICAgICBpZiAoY20gJiYgbWFya2VyLmNvbGxhcHNlZCAmJiAhY20ub3B0aW9ucy5saW5lV3JhcHBpbmcgJiYgdmlzdWFsTGluZShkb2MsIGxpbmUpID09IGNtLmRpc3BsYXkubWF4TGluZSlcbiAgICAgICAgdXBkYXRlTWF4TGluZSA9IHRydWU7XG4gICAgICB2YXIgc3BhbiA9IHtmcm9tOiBudWxsLCB0bzogbnVsbCwgbWFya2VyOiBtYXJrZXJ9O1xuICAgICAgaWYgKGN1ckxpbmUgPT0gZnJvbS5saW5lKSBzcGFuLmZyb20gPSBmcm9tLmNoO1xuICAgICAgaWYgKGN1ckxpbmUgPT0gdG8ubGluZSkgc3Bhbi50byA9IHRvLmNoO1xuICAgICAgaWYgKG1hcmtlci5jb2xsYXBzZWQgJiYgY3VyTGluZSAhPSBmcm9tLmxpbmUpIHVwZGF0ZUxpbmVIZWlnaHQobGluZSwgMCk7XG4gICAgICBhZGRNYXJrZWRTcGFuKGxpbmUsIHNwYW4pO1xuICAgICAgKytjdXJMaW5lO1xuICAgIH0pO1xuICAgIGlmIChtYXJrZXIuY29sbGFwc2VkKSBkb2MuaXRlcihmcm9tLmxpbmUsIHRvLmxpbmUgKyAxLCBmdW5jdGlvbihsaW5lKSB7XG4gICAgICBpZiAobGluZUlzSGlkZGVuKGRvYywgbGluZSkpIHVwZGF0ZUxpbmVIZWlnaHQobGluZSwgMCk7XG4gICAgfSk7XG5cbiAgICBpZiAobWFya2VyLmNsZWFyT25FbnRlcikgb24obWFya2VyLCBcImJlZm9yZUN1cnNvckVudGVyXCIsIGZ1bmN0aW9uKCkgeyBtYXJrZXIuY2xlYXIoKTsgfSk7XG5cbiAgICBpZiAobWFya2VyLnJlYWRPbmx5KSB7XG4gICAgICBzYXdSZWFkT25seVNwYW5zID0gdHJ1ZTtcbiAgICAgIGlmIChkb2MuaGlzdG9yeS5kb25lLmxlbmd0aCB8fCBkb2MuaGlzdG9yeS51bmRvbmUubGVuZ3RoKVxuICAgICAgICBkb2MuY2xlYXJIaXN0b3J5KCk7XG4gICAgfVxuICAgIGlmIChtYXJrZXIuY29sbGFwc2VkKSB7XG4gICAgICBtYXJrZXIuaWQgPSArK25leHRNYXJrZXJJZDtcbiAgICAgIG1hcmtlci5hdG9taWMgPSB0cnVlO1xuICAgIH1cbiAgICBpZiAoY20pIHtcbiAgICAgIGlmICh1cGRhdGVNYXhMaW5lKSBjbS5jdXJPcC51cGRhdGVNYXhMaW5lID0gdHJ1ZTtcbiAgICAgIGlmIChtYXJrZXIuY2xhc3NOYW1lIHx8IG1hcmtlci50aXRsZSB8fCBtYXJrZXIuc3RhcnRTdHlsZSB8fCBtYXJrZXIuZW5kU3R5bGUgfHwgbWFya2VyLmNvbGxhcHNlZClcbiAgICAgICAgcmVnQ2hhbmdlKGNtLCBmcm9tLmxpbmUsIHRvLmxpbmUgKyAxKTtcbiAgICAgIGlmIChtYXJrZXIuYXRvbWljKSByZUNoZWNrU2VsZWN0aW9uKGNtKTtcbiAgICB9XG4gICAgcmV0dXJuIG1hcmtlcjtcbiAgfVxuXG4gIC8vIFNIQVJFRCBURVhUTUFSS0VSU1xuXG4gIGZ1bmN0aW9uIFNoYXJlZFRleHRNYXJrZXIobWFya2VycywgcHJpbWFyeSkge1xuICAgIHRoaXMubWFya2VycyA9IG1hcmtlcnM7XG4gICAgdGhpcy5wcmltYXJ5ID0gcHJpbWFyeTtcbiAgICBmb3IgKHZhciBpID0gMCwgbWUgPSB0aGlzOyBpIDwgbWFya2Vycy5sZW5ndGg7ICsraSkge1xuICAgICAgbWFya2Vyc1tpXS5wYXJlbnQgPSB0aGlzO1xuICAgICAgb24obWFya2Vyc1tpXSwgXCJjbGVhclwiLCBmdW5jdGlvbigpe21lLmNsZWFyKCk7fSk7XG4gICAgfVxuICB9XG4gIENvZGVNaXJyb3IuU2hhcmVkVGV4dE1hcmtlciA9IFNoYXJlZFRleHRNYXJrZXI7XG4gIGV2ZW50TWl4aW4oU2hhcmVkVGV4dE1hcmtlcik7XG5cbiAgU2hhcmVkVGV4dE1hcmtlci5wcm90b3R5cGUuY2xlYXIgPSBmdW5jdGlvbigpIHtcbiAgICBpZiAodGhpcy5leHBsaWNpdGx5Q2xlYXJlZCkgcmV0dXJuO1xuICAgIHRoaXMuZXhwbGljaXRseUNsZWFyZWQgPSB0cnVlO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdGhpcy5tYXJrZXJzLmxlbmd0aDsgKytpKVxuICAgICAgdGhpcy5tYXJrZXJzW2ldLmNsZWFyKCk7XG4gICAgc2lnbmFsTGF0ZXIodGhpcywgXCJjbGVhclwiKTtcbiAgfTtcbiAgU2hhcmVkVGV4dE1hcmtlci5wcm90b3R5cGUuZmluZCA9IGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiB0aGlzLnByaW1hcnkuZmluZCgpO1xuICB9O1xuXG4gIGZ1bmN0aW9uIG1hcmtUZXh0U2hhcmVkKGRvYywgZnJvbSwgdG8sIG9wdGlvbnMsIHR5cGUpIHtcbiAgICBvcHRpb25zID0gY29weU9iaihvcHRpb25zKTtcbiAgICBvcHRpb25zLnNoYXJlZCA9IGZhbHNlO1xuICAgIHZhciBtYXJrZXJzID0gW21hcmtUZXh0KGRvYywgZnJvbSwgdG8sIG9wdGlvbnMsIHR5cGUpXSwgcHJpbWFyeSA9IG1hcmtlcnNbMF07XG4gICAgdmFyIHdpZGdldCA9IG9wdGlvbnMucmVwbGFjZWRXaXRoO1xuICAgIGxpbmtlZERvY3MoZG9jLCBmdW5jdGlvbihkb2MpIHtcbiAgICAgIGlmICh3aWRnZXQpIG9wdGlvbnMucmVwbGFjZWRXaXRoID0gd2lkZ2V0LmNsb25lTm9kZSh0cnVlKTtcbiAgICAgIG1hcmtlcnMucHVzaChtYXJrVGV4dChkb2MsIGNsaXBQb3MoZG9jLCBmcm9tKSwgY2xpcFBvcyhkb2MsIHRvKSwgb3B0aW9ucywgdHlwZSkpO1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBkb2MubGlua2VkLmxlbmd0aDsgKytpKVxuICAgICAgICBpZiAoZG9jLmxpbmtlZFtpXS5pc1BhcmVudCkgcmV0dXJuO1xuICAgICAgcHJpbWFyeSA9IGxzdChtYXJrZXJzKTtcbiAgICB9KTtcbiAgICByZXR1cm4gbmV3IFNoYXJlZFRleHRNYXJrZXIobWFya2VycywgcHJpbWFyeSk7XG4gIH1cblxuICAvLyBURVhUTUFSS0VSIFNQQU5TXG5cbiAgZnVuY3Rpb24gZ2V0TWFya2VkU3BhbkZvcihzcGFucywgbWFya2VyKSB7XG4gICAgaWYgKHNwYW5zKSBmb3IgKHZhciBpID0gMDsgaSA8IHNwYW5zLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YXIgc3BhbiA9IHNwYW5zW2ldO1xuICAgICAgaWYgKHNwYW4ubWFya2VyID09IG1hcmtlcikgcmV0dXJuIHNwYW47XG4gICAgfVxuICB9XG4gIGZ1bmN0aW9uIHJlbW92ZU1hcmtlZFNwYW4oc3BhbnMsIHNwYW4pIHtcbiAgICBmb3IgKHZhciByLCBpID0gMDsgaSA8IHNwYW5zLmxlbmd0aDsgKytpKVxuICAgICAgaWYgKHNwYW5zW2ldICE9IHNwYW4pIChyIHx8IChyID0gW10pKS5wdXNoKHNwYW5zW2ldKTtcbiAgICByZXR1cm4gcjtcbiAgfVxuICBmdW5jdGlvbiBhZGRNYXJrZWRTcGFuKGxpbmUsIHNwYW4pIHtcbiAgICBsaW5lLm1hcmtlZFNwYW5zID0gbGluZS5tYXJrZWRTcGFucyA/IGxpbmUubWFya2VkU3BhbnMuY29uY2F0KFtzcGFuXSkgOiBbc3Bhbl07XG4gICAgc3Bhbi5tYXJrZXIuYXR0YWNoTGluZShsaW5lKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIG1hcmtlZFNwYW5zQmVmb3JlKG9sZCwgc3RhcnRDaCwgaXNJbnNlcnQpIHtcbiAgICBpZiAob2xkKSBmb3IgKHZhciBpID0gMCwgbnc7IGkgPCBvbGQubGVuZ3RoOyArK2kpIHtcbiAgICAgIHZhciBzcGFuID0gb2xkW2ldLCBtYXJrZXIgPSBzcGFuLm1hcmtlcjtcbiAgICAgIHZhciBzdGFydHNCZWZvcmUgPSBzcGFuLmZyb20gPT0gbnVsbCB8fCAobWFya2VyLmluY2x1c2l2ZUxlZnQgPyBzcGFuLmZyb20gPD0gc3RhcnRDaCA6IHNwYW4uZnJvbSA8IHN0YXJ0Q2gpO1xuICAgICAgaWYgKHN0YXJ0c0JlZm9yZSB8fCBzcGFuLmZyb20gPT0gc3RhcnRDaCAmJiBtYXJrZXIudHlwZSA9PSBcImJvb2ttYXJrXCIgJiYgKCFpc0luc2VydCB8fCAhc3Bhbi5tYXJrZXIuaW5zZXJ0TGVmdCkpIHtcbiAgICAgICAgdmFyIGVuZHNBZnRlciA9IHNwYW4udG8gPT0gbnVsbCB8fCAobWFya2VyLmluY2x1c2l2ZVJpZ2h0ID8gc3Bhbi50byA+PSBzdGFydENoIDogc3Bhbi50byA+IHN0YXJ0Q2gpO1xuICAgICAgICAobncgfHwgKG53ID0gW10pKS5wdXNoKHtmcm9tOiBzcGFuLmZyb20sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRvOiBlbmRzQWZ0ZXIgPyBudWxsIDogc3Bhbi50byxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbWFya2VyOiBtYXJrZXJ9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIG53O1xuICB9XG5cbiAgZnVuY3Rpb24gbWFya2VkU3BhbnNBZnRlcihvbGQsIGVuZENoLCBpc0luc2VydCkge1xuICAgIGlmIChvbGQpIGZvciAodmFyIGkgPSAwLCBudzsgaSA8IG9sZC5sZW5ndGg7ICsraSkge1xuICAgICAgdmFyIHNwYW4gPSBvbGRbaV0sIG1hcmtlciA9IHNwYW4ubWFya2VyO1xuICAgICAgdmFyIGVuZHNBZnRlciA9IHNwYW4udG8gPT0gbnVsbCB8fCAobWFya2VyLmluY2x1c2l2ZVJpZ2h0ID8gc3Bhbi50byA+PSBlbmRDaCA6IHNwYW4udG8gPiBlbmRDaCk7XG4gICAgICBpZiAoZW5kc0FmdGVyIHx8IHNwYW4uZnJvbSA9PSBlbmRDaCAmJiBtYXJrZXIudHlwZSA9PSBcImJvb2ttYXJrXCIgJiYgKCFpc0luc2VydCB8fCBzcGFuLm1hcmtlci5pbnNlcnRMZWZ0KSkge1xuICAgICAgICB2YXIgc3RhcnRzQmVmb3JlID0gc3Bhbi5mcm9tID09IG51bGwgfHwgKG1hcmtlci5pbmNsdXNpdmVMZWZ0ID8gc3Bhbi5mcm9tIDw9IGVuZENoIDogc3Bhbi5mcm9tIDwgZW5kQ2gpO1xuICAgICAgICAobncgfHwgKG53ID0gW10pKS5wdXNoKHtmcm9tOiBzdGFydHNCZWZvcmUgPyBudWxsIDogc3Bhbi5mcm9tIC0gZW5kQ2gsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRvOiBzcGFuLnRvID09IG51bGwgPyBudWxsIDogc3Bhbi50byAtIGVuZENoLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBtYXJrZXI6IG1hcmtlcn0pO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gbnc7XG4gIH1cblxuICBmdW5jdGlvbiBzdHJldGNoU3BhbnNPdmVyQ2hhbmdlKGRvYywgY2hhbmdlKSB7XG4gICAgdmFyIG9sZEZpcnN0ID0gaXNMaW5lKGRvYywgY2hhbmdlLmZyb20ubGluZSkgJiYgZ2V0TGluZShkb2MsIGNoYW5nZS5mcm9tLmxpbmUpLm1hcmtlZFNwYW5zO1xuICAgIHZhciBvbGRMYXN0ID0gaXNMaW5lKGRvYywgY2hhbmdlLnRvLmxpbmUpICYmIGdldExpbmUoZG9jLCBjaGFuZ2UudG8ubGluZSkubWFya2VkU3BhbnM7XG4gICAgaWYgKCFvbGRGaXJzdCAmJiAhb2xkTGFzdCkgcmV0dXJuIG51bGw7XG5cbiAgICB2YXIgc3RhcnRDaCA9IGNoYW5nZS5mcm9tLmNoLCBlbmRDaCA9IGNoYW5nZS50by5jaCwgaXNJbnNlcnQgPSBwb3NFcShjaGFuZ2UuZnJvbSwgY2hhbmdlLnRvKTtcbiAgICAvLyBHZXQgdGhlIHNwYW5zIHRoYXQgJ3N0aWNrIG91dCcgb24gYm90aCBzaWRlc1xuICAgIHZhciBmaXJzdCA9IG1hcmtlZFNwYW5zQmVmb3JlKG9sZEZpcnN0LCBzdGFydENoLCBpc0luc2VydCk7XG4gICAgdmFyIGxhc3QgPSBtYXJrZWRTcGFuc0FmdGVyKG9sZExhc3QsIGVuZENoLCBpc0luc2VydCk7XG5cbiAgICAvLyBOZXh0LCBtZXJnZSB0aG9zZSB0d28gZW5kc1xuICAgIHZhciBzYW1lTGluZSA9IGNoYW5nZS50ZXh0Lmxlbmd0aCA9PSAxLCBvZmZzZXQgPSBsc3QoY2hhbmdlLnRleHQpLmxlbmd0aCArIChzYW1lTGluZSA/IHN0YXJ0Q2ggOiAwKTtcbiAgICBpZiAoZmlyc3QpIHtcbiAgICAgIC8vIEZpeCB1cCAudG8gcHJvcGVydGllcyBvZiBmaXJzdFxuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBmaXJzdC5sZW5ndGg7ICsraSkge1xuICAgICAgICB2YXIgc3BhbiA9IGZpcnN0W2ldO1xuICAgICAgICBpZiAoc3Bhbi50byA9PSBudWxsKSB7XG4gICAgICAgICAgdmFyIGZvdW5kID0gZ2V0TWFya2VkU3BhbkZvcihsYXN0LCBzcGFuLm1hcmtlcik7XG4gICAgICAgICAgaWYgKCFmb3VuZCkgc3Bhbi50byA9IHN0YXJ0Q2g7XG4gICAgICAgICAgZWxzZSBpZiAoc2FtZUxpbmUpIHNwYW4udG8gPSBmb3VuZC50byA9PSBudWxsID8gbnVsbCA6IGZvdW5kLnRvICsgb2Zmc2V0O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChsYXN0KSB7XG4gICAgICAvLyBGaXggdXAgLmZyb20gaW4gbGFzdCAob3IgbW92ZSB0aGVtIGludG8gZmlyc3QgaW4gY2FzZSBvZiBzYW1lTGluZSlcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGFzdC5sZW5ndGg7ICsraSkge1xuICAgICAgICB2YXIgc3BhbiA9IGxhc3RbaV07XG4gICAgICAgIGlmIChzcGFuLnRvICE9IG51bGwpIHNwYW4udG8gKz0gb2Zmc2V0O1xuICAgICAgICBpZiAoc3Bhbi5mcm9tID09IG51bGwpIHtcbiAgICAgICAgICB2YXIgZm91bmQgPSBnZXRNYXJrZWRTcGFuRm9yKGZpcnN0LCBzcGFuLm1hcmtlcik7XG4gICAgICAgICAgaWYgKCFmb3VuZCkge1xuICAgICAgICAgICAgc3Bhbi5mcm9tID0gb2Zmc2V0O1xuICAgICAgICAgICAgaWYgKHNhbWVMaW5lKSAoZmlyc3QgfHwgKGZpcnN0ID0gW10pKS5wdXNoKHNwYW4pO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBzcGFuLmZyb20gKz0gb2Zmc2V0O1xuICAgICAgICAgIGlmIChzYW1lTGluZSkgKGZpcnN0IHx8IChmaXJzdCA9IFtdKSkucHVzaChzcGFuKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICAvLyBNYWtlIHN1cmUgd2UgZGlkbid0IGNyZWF0ZSBhbnkgemVyby1sZW5ndGggc3BhbnNcbiAgICBpZiAoZmlyc3QpIGZpcnN0ID0gY2xlYXJFbXB0eVNwYW5zKGZpcnN0KTtcbiAgICBpZiAobGFzdCAmJiBsYXN0ICE9IGZpcnN0KSBsYXN0ID0gY2xlYXJFbXB0eVNwYW5zKGxhc3QpO1xuXG4gICAgdmFyIG5ld01hcmtlcnMgPSBbZmlyc3RdO1xuICAgIGlmICghc2FtZUxpbmUpIHtcbiAgICAgIC8vIEZpbGwgZ2FwIHdpdGggd2hvbGUtbGluZS1zcGFuc1xuICAgICAgdmFyIGdhcCA9IGNoYW5nZS50ZXh0Lmxlbmd0aCAtIDIsIGdhcE1hcmtlcnM7XG4gICAgICBpZiAoZ2FwID4gMCAmJiBmaXJzdClcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBmaXJzdC5sZW5ndGg7ICsraSlcbiAgICAgICAgICBpZiAoZmlyc3RbaV0udG8gPT0gbnVsbClcbiAgICAgICAgICAgIChnYXBNYXJrZXJzIHx8IChnYXBNYXJrZXJzID0gW10pKS5wdXNoKHtmcm9tOiBudWxsLCB0bzogbnVsbCwgbWFya2VyOiBmaXJzdFtpXS5tYXJrZXJ9KTtcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZ2FwOyArK2kpXG4gICAgICAgIG5ld01hcmtlcnMucHVzaChnYXBNYXJrZXJzKTtcbiAgICAgIG5ld01hcmtlcnMucHVzaChsYXN0KTtcbiAgICB9XG4gICAgcmV0dXJuIG5ld01hcmtlcnM7XG4gIH1cblxuICBmdW5jdGlvbiBjbGVhckVtcHR5U3BhbnMoc3BhbnMpIHtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHNwYW5zLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YXIgc3BhbiA9IHNwYW5zW2ldO1xuICAgICAgaWYgKHNwYW4uZnJvbSAhPSBudWxsICYmIHNwYW4uZnJvbSA9PSBzcGFuLnRvICYmIHNwYW4ubWFya2VyLmNsZWFyV2hlbkVtcHR5ICE9PSBmYWxzZSlcbiAgICAgICAgc3BhbnMuc3BsaWNlKGktLSwgMSk7XG4gICAgfVxuICAgIGlmICghc3BhbnMubGVuZ3RoKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4gc3BhbnM7XG4gIH1cblxuICBmdW5jdGlvbiBtZXJnZU9sZFNwYW5zKGRvYywgY2hhbmdlKSB7XG4gICAgdmFyIG9sZCA9IGdldE9sZFNwYW5zKGRvYywgY2hhbmdlKTtcbiAgICB2YXIgc3RyZXRjaGVkID0gc3RyZXRjaFNwYW5zT3ZlckNoYW5nZShkb2MsIGNoYW5nZSk7XG4gICAgaWYgKCFvbGQpIHJldHVybiBzdHJldGNoZWQ7XG4gICAgaWYgKCFzdHJldGNoZWQpIHJldHVybiBvbGQ7XG5cbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IG9sZC5sZW5ndGg7ICsraSkge1xuICAgICAgdmFyIG9sZEN1ciA9IG9sZFtpXSwgc3RyZXRjaEN1ciA9IHN0cmV0Y2hlZFtpXTtcbiAgICAgIGlmIChvbGRDdXIgJiYgc3RyZXRjaEN1cikge1xuICAgICAgICBzcGFuczogZm9yICh2YXIgaiA9IDA7IGogPCBzdHJldGNoQ3VyLmxlbmd0aDsgKytqKSB7XG4gICAgICAgICAgdmFyIHNwYW4gPSBzdHJldGNoQ3VyW2pdO1xuICAgICAgICAgIGZvciAodmFyIGsgPSAwOyBrIDwgb2xkQ3VyLmxlbmd0aDsgKytrKVxuICAgICAgICAgICAgaWYgKG9sZEN1cltrXS5tYXJrZXIgPT0gc3Bhbi5tYXJrZXIpIGNvbnRpbnVlIHNwYW5zO1xuICAgICAgICAgIG9sZEN1ci5wdXNoKHNwYW4pO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKHN0cmV0Y2hDdXIpIHtcbiAgICAgICAgb2xkW2ldID0gc3RyZXRjaEN1cjtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIG9sZDtcbiAgfVxuXG4gIGZ1bmN0aW9uIHJlbW92ZVJlYWRPbmx5UmFuZ2VzKGRvYywgZnJvbSwgdG8pIHtcbiAgICB2YXIgbWFya2VycyA9IG51bGw7XG4gICAgZG9jLml0ZXIoZnJvbS5saW5lLCB0by5saW5lICsgMSwgZnVuY3Rpb24obGluZSkge1xuICAgICAgaWYgKGxpbmUubWFya2VkU3BhbnMpIGZvciAodmFyIGkgPSAwOyBpIDwgbGluZS5tYXJrZWRTcGFucy5sZW5ndGg7ICsraSkge1xuICAgICAgICB2YXIgbWFyayA9IGxpbmUubWFya2VkU3BhbnNbaV0ubWFya2VyO1xuICAgICAgICBpZiAobWFyay5yZWFkT25seSAmJiAoIW1hcmtlcnMgfHwgaW5kZXhPZihtYXJrZXJzLCBtYXJrKSA9PSAtMSkpXG4gICAgICAgICAgKG1hcmtlcnMgfHwgKG1hcmtlcnMgPSBbXSkpLnB1c2gobWFyayk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgaWYgKCFtYXJrZXJzKSByZXR1cm4gbnVsbDtcbiAgICB2YXIgcGFydHMgPSBbe2Zyb206IGZyb20sIHRvOiB0b31dO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbWFya2Vycy5sZW5ndGg7ICsraSkge1xuICAgICAgdmFyIG1rID0gbWFya2Vyc1tpXSwgbSA9IG1rLmZpbmQoKTtcbiAgICAgIGZvciAodmFyIGogPSAwOyBqIDwgcGFydHMubGVuZ3RoOyArK2opIHtcbiAgICAgICAgdmFyIHAgPSBwYXJ0c1tqXTtcbiAgICAgICAgaWYgKHBvc0xlc3MocC50bywgbS5mcm9tKSB8fCBwb3NMZXNzKG0udG8sIHAuZnJvbSkpIGNvbnRpbnVlO1xuICAgICAgICB2YXIgbmV3UGFydHMgPSBbaiwgMV07XG4gICAgICAgIGlmIChwb3NMZXNzKHAuZnJvbSwgbS5mcm9tKSB8fCAhbWsuaW5jbHVzaXZlTGVmdCAmJiBwb3NFcShwLmZyb20sIG0uZnJvbSkpXG4gICAgICAgICAgbmV3UGFydHMucHVzaCh7ZnJvbTogcC5mcm9tLCB0bzogbS5mcm9tfSk7XG4gICAgICAgIGlmIChwb3NMZXNzKG0udG8sIHAudG8pIHx8ICFtay5pbmNsdXNpdmVSaWdodCAmJiBwb3NFcShwLnRvLCBtLnRvKSlcbiAgICAgICAgICBuZXdQYXJ0cy5wdXNoKHtmcm9tOiBtLnRvLCB0bzogcC50b30pO1xuICAgICAgICBwYXJ0cy5zcGxpY2UuYXBwbHkocGFydHMsIG5ld1BhcnRzKTtcbiAgICAgICAgaiArPSBuZXdQYXJ0cy5sZW5ndGggLSAxO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcGFydHM7XG4gIH1cblxuICBmdW5jdGlvbiBleHRyYUxlZnQobWFya2VyKSB7IHJldHVybiBtYXJrZXIuaW5jbHVzaXZlTGVmdCA/IC0xIDogMDsgfVxuICBmdW5jdGlvbiBleHRyYVJpZ2h0KG1hcmtlcikgeyByZXR1cm4gbWFya2VyLmluY2x1c2l2ZVJpZ2h0ID8gMSA6IDA7IH1cblxuICBmdW5jdGlvbiBjb21wYXJlQ29sbGFwc2VkTWFya2VycyhhLCBiKSB7XG4gICAgdmFyIGxlbkRpZmYgPSBhLmxpbmVzLmxlbmd0aCAtIGIubGluZXMubGVuZ3RoO1xuICAgIGlmIChsZW5EaWZmICE9IDApIHJldHVybiBsZW5EaWZmO1xuICAgIHZhciBhUG9zID0gYS5maW5kKCksIGJQb3MgPSBiLmZpbmQoKTtcbiAgICB2YXIgZnJvbUNtcCA9IGNtcChhUG9zLmZyb20sIGJQb3MuZnJvbSkgfHwgZXh0cmFMZWZ0KGEpIC0gZXh0cmFMZWZ0KGIpO1xuICAgIGlmIChmcm9tQ21wKSByZXR1cm4gLWZyb21DbXA7XG4gICAgdmFyIHRvQ21wID0gY21wKGFQb3MudG8sIGJQb3MudG8pIHx8IGV4dHJhUmlnaHQoYSkgLSBleHRyYVJpZ2h0KGIpO1xuICAgIGlmICh0b0NtcCkgcmV0dXJuIHRvQ21wO1xuICAgIHJldHVybiBiLmlkIC0gYS5pZDtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNvbGxhcHNlZFNwYW5BdFNpZGUobGluZSwgc3RhcnQpIHtcbiAgICB2YXIgc3BzID0gc2F3Q29sbGFwc2VkU3BhbnMgJiYgbGluZS5tYXJrZWRTcGFucywgZm91bmQ7XG4gICAgaWYgKHNwcykgZm9yICh2YXIgc3AsIGkgPSAwOyBpIDwgc3BzLmxlbmd0aDsgKytpKSB7XG4gICAgICBzcCA9IHNwc1tpXTtcbiAgICAgIGlmIChzcC5tYXJrZXIuY29sbGFwc2VkICYmIChzdGFydCA/IHNwLmZyb20gOiBzcC50bykgPT0gbnVsbCAmJlxuICAgICAgICAgICghZm91bmQgfHwgY29tcGFyZUNvbGxhcHNlZE1hcmtlcnMoZm91bmQsIHNwLm1hcmtlcikgPCAwKSlcbiAgICAgICAgZm91bmQgPSBzcC5tYXJrZXI7XG4gICAgfVxuICAgIHJldHVybiBmb3VuZDtcbiAgfVxuICBmdW5jdGlvbiBjb2xsYXBzZWRTcGFuQXRTdGFydChsaW5lKSB7IHJldHVybiBjb2xsYXBzZWRTcGFuQXRTaWRlKGxpbmUsIHRydWUpOyB9XG4gIGZ1bmN0aW9uIGNvbGxhcHNlZFNwYW5BdEVuZChsaW5lKSB7IHJldHVybiBjb2xsYXBzZWRTcGFuQXRTaWRlKGxpbmUsIGZhbHNlKTsgfVxuXG4gIGZ1bmN0aW9uIGNvbmZsaWN0aW5nQ29sbGFwc2VkUmFuZ2UoZG9jLCBsaW5lTm8sIGZyb20sIHRvLCBtYXJrZXIpIHtcbiAgICB2YXIgbGluZSA9IGdldExpbmUoZG9jLCBsaW5lTm8pO1xuICAgIHZhciBzcHMgPSBzYXdDb2xsYXBzZWRTcGFucyAmJiBsaW5lLm1hcmtlZFNwYW5zO1xuICAgIGlmIChzcHMpIGZvciAodmFyIGkgPSAwOyBpIDwgc3BzLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YXIgc3AgPSBzcHNbaV07XG4gICAgICBpZiAoIXNwLm1hcmtlci5jb2xsYXBzZWQpIGNvbnRpbnVlO1xuICAgICAgdmFyIGZvdW5kID0gc3AubWFya2VyLmZpbmQodHJ1ZSk7XG4gICAgICB2YXIgZnJvbUNtcCA9IGNtcChmb3VuZC5mcm9tLCBmcm9tKSB8fCBleHRyYUxlZnQoc3AubWFya2VyKSAtIGV4dHJhTGVmdChtYXJrZXIpO1xuICAgICAgdmFyIHRvQ21wID0gY21wKGZvdW5kLnRvLCB0bykgfHwgZXh0cmFSaWdodChzcC5tYXJrZXIpIC0gZXh0cmFSaWdodChtYXJrZXIpO1xuICAgICAgaWYgKGZyb21DbXAgPj0gMCAmJiB0b0NtcCA8PSAwIHx8IGZyb21DbXAgPD0gMCAmJiB0b0NtcCA+PSAwKSBjb250aW51ZTtcbiAgICAgIGlmIChmcm9tQ21wIDw9IDAgJiYgKGNtcChmb3VuZC50bywgZnJvbSkgfHwgZXh0cmFSaWdodChzcC5tYXJrZXIpIC0gZXh0cmFMZWZ0KG1hcmtlcikpID4gMCB8fFxuICAgICAgICAgIGZyb21DbXAgPj0gMCAmJiAoY21wKGZvdW5kLmZyb20sIHRvKSB8fCBleHRyYUxlZnQoc3AubWFya2VyKSAtIGV4dHJhUmlnaHQobWFya2VyKSkgPCAwKVxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiB2aXN1YWxMaW5lKGRvYywgbGluZSkge1xuICAgIHZhciBtZXJnZWQ7XG4gICAgd2hpbGUgKG1lcmdlZCA9IGNvbGxhcHNlZFNwYW5BdFN0YXJ0KGxpbmUpKVxuICAgICAgbGluZSA9IGdldExpbmUoZG9jLCBtZXJnZWQuZmluZCgpLmZyb20ubGluZSk7XG4gICAgcmV0dXJuIGxpbmU7XG4gIH1cblxuICBmdW5jdGlvbiBsaW5lSXNIaWRkZW4oZG9jLCBsaW5lKSB7XG4gICAgdmFyIHNwcyA9IHNhd0NvbGxhcHNlZFNwYW5zICYmIGxpbmUubWFya2VkU3BhbnM7XG4gICAgaWYgKHNwcykgZm9yICh2YXIgc3AsIGkgPSAwOyBpIDwgc3BzLmxlbmd0aDsgKytpKSB7XG4gICAgICBzcCA9IHNwc1tpXTtcbiAgICAgIGlmICghc3AubWFya2VyLmNvbGxhcHNlZCkgY29udGludWU7XG4gICAgICBpZiAoc3AuZnJvbSA9PSBudWxsKSByZXR1cm4gdHJ1ZTtcbiAgICAgIGlmIChzcC5tYXJrZXIucmVwbGFjZWRXaXRoKSBjb250aW51ZTtcbiAgICAgIGlmIChzcC5mcm9tID09IDAgJiYgc3AubWFya2VyLmluY2x1c2l2ZUxlZnQgJiYgbGluZUlzSGlkZGVuSW5uZXIoZG9jLCBsaW5lLCBzcCkpXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfVxuICBmdW5jdGlvbiBsaW5lSXNIaWRkZW5Jbm5lcihkb2MsIGxpbmUsIHNwYW4pIHtcbiAgICBpZiAoc3Bhbi50byA9PSBudWxsKSB7XG4gICAgICB2YXIgZW5kID0gc3Bhbi5tYXJrZXIuZmluZCgpLnRvLCBlbmRMaW5lID0gZ2V0TGluZShkb2MsIGVuZC5saW5lKTtcbiAgICAgIHJldHVybiBsaW5lSXNIaWRkZW5Jbm5lcihkb2MsIGVuZExpbmUsIGdldE1hcmtlZFNwYW5Gb3IoZW5kTGluZS5tYXJrZWRTcGFucywgc3Bhbi5tYXJrZXIpKTtcbiAgICB9XG4gICAgaWYgKHNwYW4ubWFya2VyLmluY2x1c2l2ZVJpZ2h0ICYmIHNwYW4udG8gPT0gbGluZS50ZXh0Lmxlbmd0aClcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIGZvciAodmFyIHNwLCBpID0gMDsgaSA8IGxpbmUubWFya2VkU3BhbnMubGVuZ3RoOyArK2kpIHtcbiAgICAgIHNwID0gbGluZS5tYXJrZWRTcGFuc1tpXTtcbiAgICAgIGlmIChzcC5tYXJrZXIuY29sbGFwc2VkICYmICFzcC5tYXJrZXIucmVwbGFjZWRXaXRoICYmIHNwLmZyb20gPT0gc3Bhbi50byAmJlxuICAgICAgICAgIChzcC50byA9PSBudWxsIHx8IHNwLnRvICE9IHNwYW4uZnJvbSkgJiZcbiAgICAgICAgICAoc3AubWFya2VyLmluY2x1c2l2ZUxlZnQgfHwgc3Bhbi5tYXJrZXIuaW5jbHVzaXZlUmlnaHQpICYmXG4gICAgICAgICAgbGluZUlzSGlkZGVuSW5uZXIoZG9jLCBsaW5lLCBzcCkpIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGRldGFjaE1hcmtlZFNwYW5zKGxpbmUpIHtcbiAgICB2YXIgc3BhbnMgPSBsaW5lLm1hcmtlZFNwYW5zO1xuICAgIGlmICghc3BhbnMpIHJldHVybjtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHNwYW5zLmxlbmd0aDsgKytpKVxuICAgICAgc3BhbnNbaV0ubWFya2VyLmRldGFjaExpbmUobGluZSk7XG4gICAgbGluZS5tYXJrZWRTcGFucyA9IG51bGw7XG4gIH1cblxuICBmdW5jdGlvbiBhdHRhY2hNYXJrZWRTcGFucyhsaW5lLCBzcGFucykge1xuICAgIGlmICghc3BhbnMpIHJldHVybjtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHNwYW5zLmxlbmd0aDsgKytpKVxuICAgICAgc3BhbnNbaV0ubWFya2VyLmF0dGFjaExpbmUobGluZSk7XG4gICAgbGluZS5tYXJrZWRTcGFucyA9IHNwYW5zO1xuICB9XG5cbiAgLy8gTElORSBXSURHRVRTXG5cbiAgdmFyIExpbmVXaWRnZXQgPSBDb2RlTWlycm9yLkxpbmVXaWRnZXQgPSBmdW5jdGlvbihjbSwgbm9kZSwgb3B0aW9ucykge1xuICAgIGlmIChvcHRpb25zKSBmb3IgKHZhciBvcHQgaW4gb3B0aW9ucykgaWYgKG9wdGlvbnMuaGFzT3duUHJvcGVydHkob3B0KSlcbiAgICAgIHRoaXNbb3B0XSA9IG9wdGlvbnNbb3B0XTtcbiAgICB0aGlzLmNtID0gY207XG4gICAgdGhpcy5ub2RlID0gbm9kZTtcbiAgfTtcbiAgZXZlbnRNaXhpbihMaW5lV2lkZ2V0KTtcbiAgZnVuY3Rpb24gd2lkZ2V0T3BlcmF0aW9uKGYpIHtcbiAgICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgICB2YXIgd2l0aE9wID0gIXRoaXMuY20uY3VyT3A7XG4gICAgICBpZiAod2l0aE9wKSBzdGFydE9wZXJhdGlvbih0aGlzLmNtKTtcbiAgICAgIHRyeSB7dmFyIHJlc3VsdCA9IGYuYXBwbHkodGhpcywgYXJndW1lbnRzKTt9XG4gICAgICBmaW5hbGx5IHtpZiAod2l0aE9wKSBlbmRPcGVyYXRpb24odGhpcy5jbSk7fVxuICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9O1xuICB9XG4gIExpbmVXaWRnZXQucHJvdG90eXBlLmNsZWFyID0gd2lkZ2V0T3BlcmF0aW9uKGZ1bmN0aW9uKCkge1xuICAgIHZhciB3cyA9IHRoaXMubGluZS53aWRnZXRzLCBubyA9IGxpbmVObyh0aGlzLmxpbmUpO1xuICAgIGlmIChubyA9PSBudWxsIHx8ICF3cykgcmV0dXJuO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgd3MubGVuZ3RoOyArK2kpIGlmICh3c1tpXSA9PSB0aGlzKSB3cy5zcGxpY2UoaS0tLCAxKTtcbiAgICBpZiAoIXdzLmxlbmd0aCkgdGhpcy5saW5lLndpZGdldHMgPSBudWxsO1xuICAgIHZhciBhYm92ZVZpc2libGUgPSBoZWlnaHRBdExpbmUodGhpcy5jbSwgdGhpcy5saW5lKSA8IHRoaXMuY20uZG9jLnNjcm9sbFRvcDtcbiAgICB1cGRhdGVMaW5lSGVpZ2h0KHRoaXMubGluZSwgTWF0aC5tYXgoMCwgdGhpcy5saW5lLmhlaWdodCAtIHdpZGdldEhlaWdodCh0aGlzKSkpO1xuICAgIGlmIChhYm92ZVZpc2libGUpIGFkZFRvU2Nyb2xsUG9zKHRoaXMuY20sIDAsIC10aGlzLmhlaWdodCk7XG4gICAgcmVnQ2hhbmdlKHRoaXMuY20sIG5vLCBubyArIDEpO1xuICB9KTtcbiAgTGluZVdpZGdldC5wcm90b3R5cGUuY2hhbmdlZCA9IHdpZGdldE9wZXJhdGlvbihmdW5jdGlvbigpIHtcbiAgICB2YXIgb2xkSCA9IHRoaXMuaGVpZ2h0O1xuICAgIHRoaXMuaGVpZ2h0ID0gbnVsbDtcbiAgICB2YXIgZGlmZiA9IHdpZGdldEhlaWdodCh0aGlzKSAtIG9sZEg7XG4gICAgaWYgKCFkaWZmKSByZXR1cm47XG4gICAgdXBkYXRlTGluZUhlaWdodCh0aGlzLmxpbmUsIHRoaXMubGluZS5oZWlnaHQgKyBkaWZmKTtcbiAgICB2YXIgbm8gPSBsaW5lTm8odGhpcy5saW5lKTtcbiAgICByZWdDaGFuZ2UodGhpcy5jbSwgbm8sIG5vICsgMSk7XG4gIH0pO1xuXG4gIGZ1bmN0aW9uIHdpZGdldEhlaWdodCh3aWRnZXQpIHtcbiAgICBpZiAod2lkZ2V0LmhlaWdodCAhPSBudWxsKSByZXR1cm4gd2lkZ2V0LmhlaWdodDtcbiAgICBpZiAoIXdpZGdldC5ub2RlLnBhcmVudE5vZGUgfHwgd2lkZ2V0Lm5vZGUucGFyZW50Tm9kZS5ub2RlVHlwZSAhPSAxKVxuICAgICAgcmVtb3ZlQ2hpbGRyZW5BbmRBZGQod2lkZ2V0LmNtLmRpc3BsYXkubWVhc3VyZSwgZWx0KFwiZGl2XCIsIFt3aWRnZXQubm9kZV0sIG51bGwsIFwicG9zaXRpb246IHJlbGF0aXZlXCIpKTtcbiAgICByZXR1cm4gd2lkZ2V0LmhlaWdodCA9IHdpZGdldC5ub2RlLm9mZnNldEhlaWdodDtcbiAgfVxuXG4gIGZ1bmN0aW9uIGFkZExpbmVXaWRnZXQoY20sIGhhbmRsZSwgbm9kZSwgb3B0aW9ucykge1xuICAgIHZhciB3aWRnZXQgPSBuZXcgTGluZVdpZGdldChjbSwgbm9kZSwgb3B0aW9ucyk7XG4gICAgaWYgKHdpZGdldC5ub0hTY3JvbGwpIGNtLmRpc3BsYXkuYWxpZ25XaWRnZXRzID0gdHJ1ZTtcbiAgICBjaGFuZ2VMaW5lKGNtLCBoYW5kbGUsIGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgIHZhciB3aWRnZXRzID0gbGluZS53aWRnZXRzIHx8IChsaW5lLndpZGdldHMgPSBbXSk7XG4gICAgICBpZiAod2lkZ2V0Lmluc2VydEF0ID09IG51bGwpIHdpZGdldHMucHVzaCh3aWRnZXQpO1xuICAgICAgZWxzZSB3aWRnZXRzLnNwbGljZShNYXRoLm1pbih3aWRnZXRzLmxlbmd0aCAtIDEsIE1hdGgubWF4KDAsIHdpZGdldC5pbnNlcnRBdCkpLCAwLCB3aWRnZXQpO1xuICAgICAgd2lkZ2V0LmxpbmUgPSBsaW5lO1xuICAgICAgaWYgKCFsaW5lSXNIaWRkZW4oY20uZG9jLCBsaW5lKSB8fCB3aWRnZXQuc2hvd0lmSGlkZGVuKSB7XG4gICAgICAgIHZhciBhYm92ZVZpc2libGUgPSBoZWlnaHRBdExpbmUoY20sIGxpbmUpIDwgY20uZG9jLnNjcm9sbFRvcDtcbiAgICAgICAgdXBkYXRlTGluZUhlaWdodChsaW5lLCBsaW5lLmhlaWdodCArIHdpZGdldEhlaWdodCh3aWRnZXQpKTtcbiAgICAgICAgaWYgKGFib3ZlVmlzaWJsZSkgYWRkVG9TY3JvbGxQb3MoY20sIDAsIHdpZGdldC5oZWlnaHQpO1xuICAgICAgICBjbS5jdXJPcC5mb3JjZVVwZGF0ZSA9IHRydWU7XG4gICAgICB9XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9KTtcbiAgICByZXR1cm4gd2lkZ2V0O1xuICB9XG5cbiAgLy8gTElORSBEQVRBIFNUUlVDVFVSRVxuXG4gIC8vIExpbmUgb2JqZWN0cy4gVGhlc2UgaG9sZCBzdGF0ZSByZWxhdGVkIHRvIGEgbGluZSwgaW5jbHVkaW5nXG4gIC8vIGhpZ2hsaWdodGluZyBpbmZvICh0aGUgc3R5bGVzIGFycmF5KS5cbiAgdmFyIExpbmUgPSBDb2RlTWlycm9yLkxpbmUgPSBmdW5jdGlvbih0ZXh0LCBtYXJrZWRTcGFucywgZXN0aW1hdGVIZWlnaHQpIHtcbiAgICB0aGlzLnRleHQgPSB0ZXh0O1xuICAgIGF0dGFjaE1hcmtlZFNwYW5zKHRoaXMsIG1hcmtlZFNwYW5zKTtcbiAgICB0aGlzLmhlaWdodCA9IGVzdGltYXRlSGVpZ2h0ID8gZXN0aW1hdGVIZWlnaHQodGhpcykgOiAxO1xuICB9O1xuICBldmVudE1peGluKExpbmUpO1xuICBMaW5lLnByb3RvdHlwZS5saW5lTm8gPSBmdW5jdGlvbigpIHsgcmV0dXJuIGxpbmVObyh0aGlzKTsgfTtcblxuICBmdW5jdGlvbiB1cGRhdGVMaW5lKGxpbmUsIHRleHQsIG1hcmtlZFNwYW5zLCBlc3RpbWF0ZUhlaWdodCkge1xuICAgIGxpbmUudGV4dCA9IHRleHQ7XG4gICAgaWYgKGxpbmUuc3RhdGVBZnRlcikgbGluZS5zdGF0ZUFmdGVyID0gbnVsbDtcbiAgICBpZiAobGluZS5zdHlsZXMpIGxpbmUuc3R5bGVzID0gbnVsbDtcbiAgICBpZiAobGluZS5vcmRlciAhPSBudWxsKSBsaW5lLm9yZGVyID0gbnVsbDtcbiAgICBkZXRhY2hNYXJrZWRTcGFucyhsaW5lKTtcbiAgICBhdHRhY2hNYXJrZWRTcGFucyhsaW5lLCBtYXJrZWRTcGFucyk7XG4gICAgdmFyIGVzdEhlaWdodCA9IGVzdGltYXRlSGVpZ2h0ID8gZXN0aW1hdGVIZWlnaHQobGluZSkgOiAxO1xuICAgIGlmIChlc3RIZWlnaHQgIT0gbGluZS5oZWlnaHQpIHVwZGF0ZUxpbmVIZWlnaHQobGluZSwgZXN0SGVpZ2h0KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNsZWFuVXBMaW5lKGxpbmUpIHtcbiAgICBsaW5lLnBhcmVudCA9IG51bGw7XG4gICAgZGV0YWNoTWFya2VkU3BhbnMobGluZSk7XG4gIH1cblxuICAvLyBSdW4gdGhlIGdpdmVuIG1vZGUncyBwYXJzZXIgb3ZlciBhIGxpbmUsIHVwZGF0ZSB0aGUgc3R5bGVzXG4gIC8vIGFycmF5LCB3aGljaCBjb250YWlucyBhbHRlcm5hdGluZyBmcmFnbWVudHMgb2YgdGV4dCBhbmQgQ1NTXG4gIC8vIGNsYXNzZXMuXG4gIGZ1bmN0aW9uIHJ1bk1vZGUoY20sIHRleHQsIG1vZGUsIHN0YXRlLCBmLCBmb3JjZVRvRW5kKSB7XG4gICAgdmFyIGZsYXR0ZW5TcGFucyA9IG1vZGUuZmxhdHRlblNwYW5zO1xuICAgIGlmIChmbGF0dGVuU3BhbnMgPT0gbnVsbCkgZmxhdHRlblNwYW5zID0gY20ub3B0aW9ucy5mbGF0dGVuU3BhbnM7XG4gICAgdmFyIGN1clN0YXJ0ID0gMCwgY3VyU3R5bGUgPSBudWxsO1xuICAgIHZhciBzdHJlYW0gPSBuZXcgU3RyaW5nU3RyZWFtKHRleHQsIGNtLm9wdGlvbnMudGFiU2l6ZSksIHN0eWxlO1xuICAgIGlmICh0ZXh0ID09IFwiXCIgJiYgbW9kZS5ibGFua0xpbmUpIG1vZGUuYmxhbmtMaW5lKHN0YXRlKTtcbiAgICB3aGlsZSAoIXN0cmVhbS5lb2woKSkge1xuICAgICAgaWYgKHN0cmVhbS5wb3MgPiBjbS5vcHRpb25zLm1heEhpZ2hsaWdodExlbmd0aCkge1xuICAgICAgICBmbGF0dGVuU3BhbnMgPSBmYWxzZTtcbiAgICAgICAgaWYgKGZvcmNlVG9FbmQpIHByb2Nlc3NMaW5lKGNtLCB0ZXh0LCBzdGF0ZSwgc3RyZWFtLnBvcyk7XG4gICAgICAgIHN0cmVhbS5wb3MgPSB0ZXh0Lmxlbmd0aDtcbiAgICAgICAgc3R5bGUgPSBudWxsO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc3R5bGUgPSBtb2RlLnRva2VuKHN0cmVhbSwgc3RhdGUpO1xuICAgICAgfVxuICAgICAgaWYgKGNtLm9wdGlvbnMuYWRkTW9kZUNsYXNzKSB7XG4gICAgICAgIHZhciBtTmFtZSA9IENvZGVNaXJyb3IuaW5uZXJNb2RlKG1vZGUsIHN0YXRlKS5tb2RlLm5hbWU7XG4gICAgICAgIGlmIChtTmFtZSkgc3R5bGUgPSBcIm0tXCIgKyAoc3R5bGUgPyBtTmFtZSArIFwiIFwiICsgc3R5bGUgOiBtTmFtZSk7XG4gICAgICB9XG4gICAgICBpZiAoIWZsYXR0ZW5TcGFucyB8fCBjdXJTdHlsZSAhPSBzdHlsZSkge1xuICAgICAgICBpZiAoY3VyU3RhcnQgPCBzdHJlYW0uc3RhcnQpIGYoc3RyZWFtLnN0YXJ0LCBjdXJTdHlsZSk7XG4gICAgICAgIGN1clN0YXJ0ID0gc3RyZWFtLnN0YXJ0OyBjdXJTdHlsZSA9IHN0eWxlO1xuICAgICAgfVxuICAgICAgc3RyZWFtLnN0YXJ0ID0gc3RyZWFtLnBvcztcbiAgICB9XG4gICAgd2hpbGUgKGN1clN0YXJ0IDwgc3RyZWFtLnBvcykge1xuICAgICAgLy8gV2Via2l0IHNlZW1zIHRvIHJlZnVzZSB0byByZW5kZXIgdGV4dCBub2RlcyBsb25nZXIgdGhhbiA1NzQ0NCBjaGFyYWN0ZXJzXG4gICAgICB2YXIgcG9zID0gTWF0aC5taW4oc3RyZWFtLnBvcywgY3VyU3RhcnQgKyA1MDAwMCk7XG4gICAgICBmKHBvcywgY3VyU3R5bGUpO1xuICAgICAgY3VyU3RhcnQgPSBwb3M7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gaGlnaGxpZ2h0TGluZShjbSwgbGluZSwgc3RhdGUsIGZvcmNlVG9FbmQpIHtcbiAgICAvLyBBIHN0eWxlcyBhcnJheSBhbHdheXMgc3RhcnRzIHdpdGggYSBudW1iZXIgaWRlbnRpZnlpbmcgdGhlXG4gICAgLy8gbW9kZS9vdmVybGF5cyB0aGF0IGl0IGlzIGJhc2VkIG9uIChmb3IgZWFzeSBpbnZhbGlkYXRpb24pLlxuICAgIHZhciBzdCA9IFtjbS5zdGF0ZS5tb2RlR2VuXTtcbiAgICAvLyBDb21wdXRlIHRoZSBiYXNlIGFycmF5IG9mIHN0eWxlc1xuICAgIHJ1bk1vZGUoY20sIGxpbmUudGV4dCwgY20uZG9jLm1vZGUsIHN0YXRlLCBmdW5jdGlvbihlbmQsIHN0eWxlKSB7XG4gICAgICBzdC5wdXNoKGVuZCwgc3R5bGUpO1xuICAgIH0sIGZvcmNlVG9FbmQpO1xuXG4gICAgLy8gUnVuIG92ZXJsYXlzLCBhZGp1c3Qgc3R5bGUgYXJyYXkuXG4gICAgZm9yICh2YXIgbyA9IDA7IG8gPCBjbS5zdGF0ZS5vdmVybGF5cy5sZW5ndGg7ICsrbykge1xuICAgICAgdmFyIG92ZXJsYXkgPSBjbS5zdGF0ZS5vdmVybGF5c1tvXSwgaSA9IDEsIGF0ID0gMDtcbiAgICAgIHJ1bk1vZGUoY20sIGxpbmUudGV4dCwgb3ZlcmxheS5tb2RlLCB0cnVlLCBmdW5jdGlvbihlbmQsIHN0eWxlKSB7XG4gICAgICAgIHZhciBzdGFydCA9IGk7XG4gICAgICAgIC8vIEVuc3VyZSB0aGVyZSdzIGEgdG9rZW4gZW5kIGF0IHRoZSBjdXJyZW50IHBvc2l0aW9uLCBhbmQgdGhhdCBpIHBvaW50cyBhdCBpdFxuICAgICAgICB3aGlsZSAoYXQgPCBlbmQpIHtcbiAgICAgICAgICB2YXIgaV9lbmQgPSBzdFtpXTtcbiAgICAgICAgICBpZiAoaV9lbmQgPiBlbmQpXG4gICAgICAgICAgICBzdC5zcGxpY2UoaSwgMSwgZW5kLCBzdFtpKzFdLCBpX2VuZCk7XG4gICAgICAgICAgaSArPSAyO1xuICAgICAgICAgIGF0ID0gTWF0aC5taW4oZW5kLCBpX2VuZCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFzdHlsZSkgcmV0dXJuO1xuICAgICAgICBpZiAob3ZlcmxheS5vcGFxdWUpIHtcbiAgICAgICAgICBzdC5zcGxpY2Uoc3RhcnQsIGkgLSBzdGFydCwgZW5kLCBzdHlsZSk7XG4gICAgICAgICAgaSA9IHN0YXJ0ICsgMjtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBmb3IgKDsgc3RhcnQgPCBpOyBzdGFydCArPSAyKSB7XG4gICAgICAgICAgICB2YXIgY3VyID0gc3Rbc3RhcnQrMV07XG4gICAgICAgICAgICBzdFtzdGFydCsxXSA9IGN1ciA/IGN1ciArIFwiIFwiICsgc3R5bGUgOiBzdHlsZTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiBzdDtcbiAgfVxuXG4gIGZ1bmN0aW9uIGdldExpbmVTdHlsZXMoY20sIGxpbmUpIHtcbiAgICBpZiAoIWxpbmUuc3R5bGVzIHx8IGxpbmUuc3R5bGVzWzBdICE9IGNtLnN0YXRlLm1vZGVHZW4pXG4gICAgICBsaW5lLnN0eWxlcyA9IGhpZ2hsaWdodExpbmUoY20sIGxpbmUsIGxpbmUuc3RhdGVBZnRlciA9IGdldFN0YXRlQmVmb3JlKGNtLCBsaW5lTm8obGluZSkpKTtcbiAgICByZXR1cm4gbGluZS5zdHlsZXM7XG4gIH1cblxuICAvLyBMaWdodHdlaWdodCBmb3JtIG9mIGhpZ2hsaWdodCAtLSBwcm9jZWVkIG92ZXIgdGhpcyBsaW5lIGFuZFxuICAvLyB1cGRhdGUgc3RhdGUsIGJ1dCBkb24ndCBzYXZlIGEgc3R5bGUgYXJyYXkuXG4gIGZ1bmN0aW9uIHByb2Nlc3NMaW5lKGNtLCB0ZXh0LCBzdGF0ZSwgc3RhcnRBdCkge1xuICAgIHZhciBtb2RlID0gY20uZG9jLm1vZGU7XG4gICAgdmFyIHN0cmVhbSA9IG5ldyBTdHJpbmdTdHJlYW0odGV4dCwgY20ub3B0aW9ucy50YWJTaXplKTtcbiAgICBzdHJlYW0uc3RhcnQgPSBzdHJlYW0ucG9zID0gc3RhcnRBdCB8fCAwO1xuICAgIGlmICh0ZXh0ID09IFwiXCIgJiYgbW9kZS5ibGFua0xpbmUpIG1vZGUuYmxhbmtMaW5lKHN0YXRlKTtcbiAgICB3aGlsZSAoIXN0cmVhbS5lb2woKSAmJiBzdHJlYW0ucG9zIDw9IGNtLm9wdGlvbnMubWF4SGlnaGxpZ2h0TGVuZ3RoKSB7XG4gICAgICBtb2RlLnRva2VuKHN0cmVhbSwgc3RhdGUpO1xuICAgICAgc3RyZWFtLnN0YXJ0ID0gc3RyZWFtLnBvcztcbiAgICB9XG4gIH1cblxuICB2YXIgc3R5bGVUb0NsYXNzQ2FjaGUgPSB7fSwgc3R5bGVUb0NsYXNzQ2FjaGVXaXRoTW9kZSA9IHt9O1xuICBmdW5jdGlvbiBpbnRlcnByZXRUb2tlblN0eWxlKHN0eWxlLCBidWlsZGVyKSB7XG4gICAgaWYgKCFzdHlsZSkgcmV0dXJuIG51bGw7XG4gICAgZm9yICg7Oykge1xuICAgICAgdmFyIGxpbmVDbGFzcyA9IHN0eWxlLm1hdGNoKC8oPzpefFxccyspbGluZS0oYmFja2dyb3VuZC0pPyhcXFMrKS8pO1xuICAgICAgaWYgKCFsaW5lQ2xhc3MpIGJyZWFrO1xuICAgICAgc3R5bGUgPSBzdHlsZS5zbGljZSgwLCBsaW5lQ2xhc3MuaW5kZXgpICsgc3R5bGUuc2xpY2UobGluZUNsYXNzLmluZGV4ICsgbGluZUNsYXNzWzBdLmxlbmd0aCk7XG4gICAgICB2YXIgcHJvcCA9IGxpbmVDbGFzc1sxXSA/IFwiYmdDbGFzc1wiIDogXCJ0ZXh0Q2xhc3NcIjtcbiAgICAgIGlmIChidWlsZGVyW3Byb3BdID09IG51bGwpXG4gICAgICAgIGJ1aWxkZXJbcHJvcF0gPSBsaW5lQ2xhc3NbMl07XG4gICAgICBlbHNlIGlmICghKG5ldyBSZWdFeHAoXCIoPzpefFxccylcIiArIGxpbmVDbGFzc1syXSArIFwiKD86JHxcXHMpXCIpKS50ZXN0KGJ1aWxkZXJbcHJvcF0pKVxuICAgICAgICBidWlsZGVyW3Byb3BdICs9IFwiIFwiICsgbGluZUNsYXNzWzJdO1xuICAgIH1cbiAgICBpZiAoL15cXHMqJC8udGVzdChzdHlsZSkpIHJldHVybiBudWxsO1xuICAgIHZhciBjYWNoZSA9IGJ1aWxkZXIuY20ub3B0aW9ucy5hZGRNb2RlQ2xhc3MgPyBzdHlsZVRvQ2xhc3NDYWNoZVdpdGhNb2RlIDogc3R5bGVUb0NsYXNzQ2FjaGU7XG4gICAgcmV0dXJuIGNhY2hlW3N0eWxlXSB8fFxuICAgICAgKGNhY2hlW3N0eWxlXSA9IHN0eWxlLnJlcGxhY2UoL1xcUysvZywgXCJjbS0kJlwiKSk7XG4gIH1cblxuICBmdW5jdGlvbiBidWlsZExpbmVDb250ZW50KGNtLCByZWFsTGluZSwgbWVhc3VyZSwgY29weVdpZGdldHMpIHtcbiAgICB2YXIgbWVyZ2VkLCBsaW5lID0gcmVhbExpbmUsIGVtcHR5ID0gdHJ1ZTtcbiAgICB3aGlsZSAobWVyZ2VkID0gY29sbGFwc2VkU3BhbkF0U3RhcnQobGluZSkpXG4gICAgICBsaW5lID0gZ2V0TGluZShjbS5kb2MsIG1lcmdlZC5maW5kKCkuZnJvbS5saW5lKTtcblxuICAgIHZhciBidWlsZGVyID0ge3ByZTogZWx0KFwicHJlXCIpLCBjb2w6IDAsIHBvczogMCxcbiAgICAgICAgICAgICAgICAgICBtZWFzdXJlOiBudWxsLCBtZWFzdXJlZFNvbWV0aGluZzogZmFsc2UsIGNtOiBjbSxcbiAgICAgICAgICAgICAgICAgICBjb3B5V2lkZ2V0czogY29weVdpZGdldHN9O1xuXG4gICAgZG8ge1xuICAgICAgaWYgKGxpbmUudGV4dCkgZW1wdHkgPSBmYWxzZTtcbiAgICAgIGJ1aWxkZXIubWVhc3VyZSA9IGxpbmUgPT0gcmVhbExpbmUgJiYgbWVhc3VyZTtcbiAgICAgIGJ1aWxkZXIucG9zID0gMDtcbiAgICAgIGJ1aWxkZXIuYWRkVG9rZW4gPSBidWlsZGVyLm1lYXN1cmUgPyBidWlsZFRva2VuTWVhc3VyZSA6IGJ1aWxkVG9rZW47XG4gICAgICBpZiAoKGllIHx8IHdlYmtpdCkgJiYgY20uZ2V0T3B0aW9uKFwibGluZVdyYXBwaW5nXCIpKVxuICAgICAgICBidWlsZGVyLmFkZFRva2VuID0gYnVpbGRUb2tlblNwbGl0U3BhY2VzKGJ1aWxkZXIuYWRkVG9rZW4pO1xuICAgICAgdmFyIG5leHQgPSBpbnNlcnRMaW5lQ29udGVudChsaW5lLCBidWlsZGVyLCBnZXRMaW5lU3R5bGVzKGNtLCBsaW5lKSk7XG4gICAgICBpZiAobWVhc3VyZSAmJiBsaW5lID09IHJlYWxMaW5lICYmICFidWlsZGVyLm1lYXN1cmVkU29tZXRoaW5nKSB7XG4gICAgICAgIG1lYXN1cmVbMF0gPSBidWlsZGVyLnByZS5hcHBlbmRDaGlsZCh6ZXJvV2lkdGhFbGVtZW50KGNtLmRpc3BsYXkubWVhc3VyZSkpO1xuICAgICAgICBidWlsZGVyLm1lYXN1cmVkU29tZXRoaW5nID0gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIGlmIChuZXh0KSBsaW5lID0gZ2V0TGluZShjbS5kb2MsIG5leHQudG8ubGluZSk7XG4gICAgfSB3aGlsZSAobmV4dCk7XG5cbiAgICBpZiAobWVhc3VyZSAmJiAhYnVpbGRlci5tZWFzdXJlZFNvbWV0aGluZyAmJiAhbWVhc3VyZVswXSlcbiAgICAgIG1lYXN1cmVbMF0gPSBidWlsZGVyLnByZS5hcHBlbmRDaGlsZChlbXB0eSA/IGVsdChcInNwYW5cIiwgXCJcXHUwMGEwXCIpIDogemVyb1dpZHRoRWxlbWVudChjbS5kaXNwbGF5Lm1lYXN1cmUpKTtcbiAgICBpZiAoIWJ1aWxkZXIucHJlLmZpcnN0Q2hpbGQgJiYgIWxpbmVJc0hpZGRlbihjbS5kb2MsIHJlYWxMaW5lKSlcbiAgICAgIGJ1aWxkZXIucHJlLmFwcGVuZENoaWxkKGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKFwiXFx1MDBhMFwiKSk7XG5cbiAgICB2YXIgb3JkZXI7XG4gICAgLy8gV29yayBhcm91bmQgcHJvYmxlbSB3aXRoIHRoZSByZXBvcnRlZCBkaW1lbnNpb25zIG9mIHNpbmdsZS1jaGFyXG4gICAgLy8gZGlyZWN0aW9uIHNwYW5zIG9uIElFIChpc3N1ZSAjMTEyOSkuIFNlZSBhbHNvIHRoZSBjb21tZW50IGluXG4gICAgLy8gY3Vyc29yQ29vcmRzLlxuICAgIGlmIChtZWFzdXJlICYmIGllICYmIChvcmRlciA9IGdldE9yZGVyKGxpbmUpKSkge1xuICAgICAgdmFyIGwgPSBvcmRlci5sZW5ndGggLSAxO1xuICAgICAgaWYgKG9yZGVyW2xdLmZyb20gPT0gb3JkZXJbbF0udG8pIC0tbDtcbiAgICAgIHZhciBsYXN0ID0gb3JkZXJbbF0sIHByZXYgPSBvcmRlcltsIC0gMV07XG4gICAgICBpZiAobGFzdC5mcm9tICsgMSA9PSBsYXN0LnRvICYmIHByZXYgJiYgbGFzdC5sZXZlbCA8IHByZXYubGV2ZWwpIHtcbiAgICAgICAgdmFyIHNwYW4gPSBtZWFzdXJlW2J1aWxkZXIucG9zIC0gMV07XG4gICAgICAgIGlmIChzcGFuKSBzcGFuLnBhcmVudE5vZGUuaW5zZXJ0QmVmb3JlKHNwYW4ubWVhc3VyZVJpZ2h0ID0gemVyb1dpZHRoRWxlbWVudChjbS5kaXNwbGF5Lm1lYXN1cmUpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcGFuLm5leHRTaWJsaW5nKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB2YXIgdGV4dENsYXNzID0gYnVpbGRlci50ZXh0Q2xhc3MgPyBidWlsZGVyLnRleHRDbGFzcyArIFwiIFwiICsgKHJlYWxMaW5lLnRleHRDbGFzcyB8fCBcIlwiKSA6IHJlYWxMaW5lLnRleHRDbGFzcztcbiAgICBpZiAodGV4dENsYXNzKSBidWlsZGVyLnByZS5jbGFzc05hbWUgPSB0ZXh0Q2xhc3M7XG5cbiAgICBzaWduYWwoY20sIFwicmVuZGVyTGluZVwiLCBjbSwgcmVhbExpbmUsIGJ1aWxkZXIucHJlKTtcbiAgICByZXR1cm4gYnVpbGRlcjtcbiAgfVxuXG4gIGZ1bmN0aW9uIGRlZmF1bHRTcGVjaWFsQ2hhclBsYWNlaG9sZGVyKGNoKSB7XG4gICAgdmFyIHRva2VuID0gZWx0KFwic3BhblwiLCBcIlxcdTIwMjJcIiwgXCJjbS1pbnZhbGlkY2hhclwiKTtcbiAgICB0b2tlbi50aXRsZSA9IFwiXFxcXHVcIiArIGNoLmNoYXJDb2RlQXQoMCkudG9TdHJpbmcoMTYpO1xuICAgIHJldHVybiB0b2tlbjtcbiAgfVxuXG4gIGZ1bmN0aW9uIGJ1aWxkVG9rZW4oYnVpbGRlciwgdGV4dCwgc3R5bGUsIHN0YXJ0U3R5bGUsIGVuZFN0eWxlLCB0aXRsZSkge1xuICAgIGlmICghdGV4dCkgcmV0dXJuO1xuICAgIHZhciBzcGVjaWFsID0gYnVpbGRlci5jbS5vcHRpb25zLnNwZWNpYWxDaGFycztcbiAgICBpZiAoIXNwZWNpYWwudGVzdCh0ZXh0KSkge1xuICAgICAgYnVpbGRlci5jb2wgKz0gdGV4dC5sZW5ndGg7XG4gICAgICB2YXIgY29udGVudCA9IGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKHRleHQpO1xuICAgIH0gZWxzZSB7XG4gICAgICB2YXIgY29udGVudCA9IGRvY3VtZW50LmNyZWF0ZURvY3VtZW50RnJhZ21lbnQoKSwgcG9zID0gMDtcbiAgICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICAgIHNwZWNpYWwubGFzdEluZGV4ID0gcG9zO1xuICAgICAgICB2YXIgbSA9IHNwZWNpYWwuZXhlYyh0ZXh0KTtcbiAgICAgICAgdmFyIHNraXBwZWQgPSBtID8gbS5pbmRleCAtIHBvcyA6IHRleHQubGVuZ3RoIC0gcG9zO1xuICAgICAgICBpZiAoc2tpcHBlZCkge1xuICAgICAgICAgIGNvbnRlbnQuYXBwZW5kQ2hpbGQoZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUodGV4dC5zbGljZShwb3MsIHBvcyArIHNraXBwZWQpKSk7XG4gICAgICAgICAgYnVpbGRlci5jb2wgKz0gc2tpcHBlZDtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIW0pIGJyZWFrO1xuICAgICAgICBwb3MgKz0gc2tpcHBlZCArIDE7XG4gICAgICAgIGlmIChtWzBdID09IFwiXFx0XCIpIHtcbiAgICAgICAgICB2YXIgdGFiU2l6ZSA9IGJ1aWxkZXIuY20ub3B0aW9ucy50YWJTaXplLCB0YWJXaWR0aCA9IHRhYlNpemUgLSBidWlsZGVyLmNvbCAlIHRhYlNpemU7XG4gICAgICAgICAgY29udGVudC5hcHBlbmRDaGlsZChlbHQoXCJzcGFuXCIsIHNwYWNlU3RyKHRhYldpZHRoKSwgXCJjbS10YWJcIikpO1xuICAgICAgICAgIGJ1aWxkZXIuY29sICs9IHRhYldpZHRoO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHZhciB0b2tlbiA9IGJ1aWxkZXIuY20ub3B0aW9ucy5zcGVjaWFsQ2hhclBsYWNlaG9sZGVyKG1bMF0pO1xuICAgICAgICAgIGNvbnRlbnQuYXBwZW5kQ2hpbGQodG9rZW4pO1xuICAgICAgICAgIGJ1aWxkZXIuY29sICs9IDE7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHN0eWxlIHx8IHN0YXJ0U3R5bGUgfHwgZW5kU3R5bGUgfHwgYnVpbGRlci5tZWFzdXJlKSB7XG4gICAgICB2YXIgZnVsbFN0eWxlID0gc3R5bGUgfHwgXCJcIjtcbiAgICAgIGlmIChzdGFydFN0eWxlKSBmdWxsU3R5bGUgKz0gc3RhcnRTdHlsZTtcbiAgICAgIGlmIChlbmRTdHlsZSkgZnVsbFN0eWxlICs9IGVuZFN0eWxlO1xuICAgICAgdmFyIHRva2VuID0gZWx0KFwic3BhblwiLCBbY29udGVudF0sIGZ1bGxTdHlsZSk7XG4gICAgICBpZiAodGl0bGUpIHRva2VuLnRpdGxlID0gdGl0bGU7XG4gICAgICByZXR1cm4gYnVpbGRlci5wcmUuYXBwZW5kQ2hpbGQodG9rZW4pO1xuICAgIH1cbiAgICBidWlsZGVyLnByZS5hcHBlbmRDaGlsZChjb250ZW50KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGJ1aWxkVG9rZW5NZWFzdXJlKGJ1aWxkZXIsIHRleHQsIHN0eWxlLCBzdGFydFN0eWxlLCBlbmRTdHlsZSkge1xuICAgIHZhciB3cmFwcGluZyA9IGJ1aWxkZXIuY20ub3B0aW9ucy5saW5lV3JhcHBpbmc7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCB0ZXh0Lmxlbmd0aDsgKytpKSB7XG4gICAgICB2YXIgc3RhcnQgPSBpID09IDAsIHRvID0gaSArIDE7XG4gICAgICB3aGlsZSAodG8gPCB0ZXh0Lmxlbmd0aCAmJiBpc0V4dGVuZGluZ0NoYXIodGV4dC5jaGFyQXQodG8pKSkgKyt0bztcbiAgICAgIHZhciBjaCA9IHRleHQuc2xpY2UoaSwgdG8pO1xuICAgICAgaSA9IHRvIC0gMTtcbiAgICAgIGlmIChpICYmIHdyYXBwaW5nICYmIHNwYW5BZmZlY3RzV3JhcHBpbmcodGV4dCwgaSkpXG4gICAgICAgIGJ1aWxkZXIucHJlLmFwcGVuZENoaWxkKGVsdChcIndiclwiKSk7XG4gICAgICB2YXIgb2xkID0gYnVpbGRlci5tZWFzdXJlW2J1aWxkZXIucG9zXTtcbiAgICAgIHZhciBzcGFuID0gYnVpbGRlci5tZWFzdXJlW2J1aWxkZXIucG9zXSA9XG4gICAgICAgIGJ1aWxkVG9rZW4oYnVpbGRlciwgY2gsIHN0eWxlLFxuICAgICAgICAgICAgICAgICAgIHN0YXJ0ICYmIHN0YXJ0U3R5bGUsIGkgPT0gdGV4dC5sZW5ndGggLSAxICYmIGVuZFN0eWxlKTtcbiAgICAgIGlmIChvbGQpIHNwYW4ubGVmdFNpZGUgPSBvbGQubGVmdFNpZGUgfHwgb2xkO1xuICAgICAgLy8gSW4gSUUgc2luZ2xlLXNwYWNlIG5vZGVzIHdyYXAgZGlmZmVyZW50bHkgdGhhbiBzcGFjZXNcbiAgICAgIC8vIGVtYmVkZGVkIGluIGxhcmdlciB0ZXh0IG5vZGVzLCBleGNlcHQgd2hlbiBzZXQgdG9cbiAgICAgIC8vIHdoaXRlLXNwYWNlOiBub3JtYWwgKGlzc3VlICMxMjY4KS5cbiAgICAgIGlmIChvbGRfaWUgJiYgd3JhcHBpbmcgJiYgY2ggPT0gXCIgXCIgJiYgaSAmJiAhL1xccy8udGVzdCh0ZXh0LmNoYXJBdChpIC0gMSkpICYmXG4gICAgICAgICAgaSA8IHRleHQubGVuZ3RoIC0gMSAmJiAhL1xccy8udGVzdCh0ZXh0LmNoYXJBdChpICsgMSkpKVxuICAgICAgICBzcGFuLnN0eWxlLndoaXRlU3BhY2UgPSBcIm5vcm1hbFwiO1xuICAgICAgYnVpbGRlci5wb3MgKz0gY2gubGVuZ3RoO1xuICAgIH1cbiAgICBpZiAodGV4dC5sZW5ndGgpIGJ1aWxkZXIubWVhc3VyZWRTb21ldGhpbmcgPSB0cnVlO1xuICB9XG5cbiAgZnVuY3Rpb24gYnVpbGRUb2tlblNwbGl0U3BhY2VzKGlubmVyKSB7XG4gICAgZnVuY3Rpb24gc3BsaXQob2xkKSB7XG4gICAgICB2YXIgb3V0ID0gXCIgXCI7XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IG9sZC5sZW5ndGggLSAyOyArK2kpIG91dCArPSBpICUgMiA/IFwiIFwiIDogXCJcXHUwMGEwXCI7XG4gICAgICBvdXQgKz0gXCIgXCI7XG4gICAgICByZXR1cm4gb3V0O1xuICAgIH1cbiAgICByZXR1cm4gZnVuY3Rpb24oYnVpbGRlciwgdGV4dCwgc3R5bGUsIHN0YXJ0U3R5bGUsIGVuZFN0eWxlLCB0aXRsZSkge1xuICAgICAgcmV0dXJuIGlubmVyKGJ1aWxkZXIsIHRleHQucmVwbGFjZSgvIHszLH0vZywgc3BsaXQpLCBzdHlsZSwgc3RhcnRTdHlsZSwgZW5kU3R5bGUsIHRpdGxlKTtcbiAgICB9O1xuICB9XG5cbiAgZnVuY3Rpb24gYnVpbGRDb2xsYXBzZWRTcGFuKGJ1aWxkZXIsIHNpemUsIG1hcmtlciwgaWdub3JlV2lkZ2V0KSB7XG4gICAgdmFyIHdpZGdldCA9ICFpZ25vcmVXaWRnZXQgJiYgbWFya2VyLnJlcGxhY2VkV2l0aDtcbiAgICBpZiAod2lkZ2V0KSB7XG4gICAgICBpZiAoYnVpbGRlci5jb3B5V2lkZ2V0cykgd2lkZ2V0ID0gd2lkZ2V0LmNsb25lTm9kZSh0cnVlKTtcbiAgICAgIGJ1aWxkZXIucHJlLmFwcGVuZENoaWxkKHdpZGdldCk7XG4gICAgICBpZiAoYnVpbGRlci5tZWFzdXJlKSB7XG4gICAgICAgIGlmIChzaXplKSB7XG4gICAgICAgICAgYnVpbGRlci5tZWFzdXJlW2J1aWxkZXIucG9zXSA9IHdpZGdldDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB2YXIgZWx0ID0gemVyb1dpZHRoRWxlbWVudChidWlsZGVyLmNtLmRpc3BsYXkubWVhc3VyZSk7XG4gICAgICAgICAgaWYgKG1hcmtlci50eXBlID09IFwiYm9va21hcmtcIiAmJiAhbWFya2VyLmluc2VydExlZnQpXG4gICAgICAgICAgICBidWlsZGVyLm1lYXN1cmVbYnVpbGRlci5wb3NdID0gYnVpbGRlci5wcmUuYXBwZW5kQ2hpbGQoZWx0KTtcbiAgICAgICAgICBlbHNlIGlmIChidWlsZGVyLm1lYXN1cmVbYnVpbGRlci5wb3NdKVxuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIGVsc2VcbiAgICAgICAgICAgIGJ1aWxkZXIubWVhc3VyZVtidWlsZGVyLnBvc10gPSBidWlsZGVyLnByZS5pbnNlcnRCZWZvcmUoZWx0LCB3aWRnZXQpO1xuICAgICAgICB9XG4gICAgICAgIGJ1aWxkZXIubWVhc3VyZWRTb21ldGhpbmcgPSB0cnVlO1xuICAgICAgfVxuICAgIH1cbiAgICBidWlsZGVyLnBvcyArPSBzaXplO1xuICB9XG5cbiAgLy8gT3V0cHV0cyBhIG51bWJlciBvZiBzcGFucyB0byBtYWtlIHVwIGEgbGluZSwgdGFraW5nIGhpZ2hsaWdodGluZ1xuICAvLyBhbmQgbWFya2VkIHRleHQgaW50byBhY2NvdW50LlxuICBmdW5jdGlvbiBpbnNlcnRMaW5lQ29udGVudChsaW5lLCBidWlsZGVyLCBzdHlsZXMpIHtcbiAgICB2YXIgc3BhbnMgPSBsaW5lLm1hcmtlZFNwYW5zLCBhbGxUZXh0ID0gbGluZS50ZXh0LCBhdCA9IDA7XG4gICAgaWYgKCFzcGFucykge1xuICAgICAgZm9yICh2YXIgaSA9IDE7IGkgPCBzdHlsZXMubGVuZ3RoOyBpKz0yKVxuICAgICAgICBidWlsZGVyLmFkZFRva2VuKGJ1aWxkZXIsIGFsbFRleHQuc2xpY2UoYXQsIGF0ID0gc3R5bGVzW2ldKSwgaW50ZXJwcmV0VG9rZW5TdHlsZShzdHlsZXNbaSsxXSwgYnVpbGRlcikpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHZhciBsZW4gPSBhbGxUZXh0Lmxlbmd0aCwgcG9zID0gMCwgaSA9IDEsIHRleHQgPSBcIlwiLCBzdHlsZTtcbiAgICB2YXIgbmV4dENoYW5nZSA9IDAsIHNwYW5TdHlsZSwgc3BhbkVuZFN0eWxlLCBzcGFuU3RhcnRTdHlsZSwgdGl0bGUsIGNvbGxhcHNlZDtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBpZiAobmV4dENoYW5nZSA9PSBwb3MpIHsgLy8gVXBkYXRlIGN1cnJlbnQgbWFya2VyIHNldFxuICAgICAgICBzcGFuU3R5bGUgPSBzcGFuRW5kU3R5bGUgPSBzcGFuU3RhcnRTdHlsZSA9IHRpdGxlID0gXCJcIjtcbiAgICAgICAgY29sbGFwc2VkID0gbnVsbDsgbmV4dENoYW5nZSA9IEluZmluaXR5O1xuICAgICAgICB2YXIgZm91bmRCb29rbWFya3MgPSBbXTtcbiAgICAgICAgZm9yICh2YXIgaiA9IDA7IGogPCBzcGFucy5sZW5ndGg7ICsraikge1xuICAgICAgICAgIHZhciBzcCA9IHNwYW5zW2pdLCBtID0gc3AubWFya2VyO1xuICAgICAgICAgIGlmIChzcC5mcm9tIDw9IHBvcyAmJiAoc3AudG8gPT0gbnVsbCB8fCBzcC50byA+IHBvcykpIHtcbiAgICAgICAgICAgIGlmIChzcC50byAhPSBudWxsICYmIG5leHRDaGFuZ2UgPiBzcC50bykgeyBuZXh0Q2hhbmdlID0gc3AudG87IHNwYW5FbmRTdHlsZSA9IFwiXCI7IH1cbiAgICAgICAgICAgIGlmIChtLmNsYXNzTmFtZSkgc3BhblN0eWxlICs9IFwiIFwiICsgbS5jbGFzc05hbWU7XG4gICAgICAgICAgICBpZiAobS5zdGFydFN0eWxlICYmIHNwLmZyb20gPT0gcG9zKSBzcGFuU3RhcnRTdHlsZSArPSBcIiBcIiArIG0uc3RhcnRTdHlsZTtcbiAgICAgICAgICAgIGlmIChtLmVuZFN0eWxlICYmIHNwLnRvID09IG5leHRDaGFuZ2UpIHNwYW5FbmRTdHlsZSArPSBcIiBcIiArIG0uZW5kU3R5bGU7XG4gICAgICAgICAgICBpZiAobS50aXRsZSAmJiAhdGl0bGUpIHRpdGxlID0gbS50aXRsZTtcbiAgICAgICAgICAgIGlmIChtLmNvbGxhcHNlZCAmJiAoIWNvbGxhcHNlZCB8fCBjb21wYXJlQ29sbGFwc2VkTWFya2Vycyhjb2xsYXBzZWQubWFya2VyLCBtKSA8IDApKVxuICAgICAgICAgICAgICBjb2xsYXBzZWQgPSBzcDtcbiAgICAgICAgICB9IGVsc2UgaWYgKHNwLmZyb20gPiBwb3MgJiYgbmV4dENoYW5nZSA+IHNwLmZyb20pIHtcbiAgICAgICAgICAgIG5leHRDaGFuZ2UgPSBzcC5mcm9tO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAobS50eXBlID09IFwiYm9va21hcmtcIiAmJiBzcC5mcm9tID09IHBvcyAmJiBtLnJlcGxhY2VkV2l0aCkgZm91bmRCb29rbWFya3MucHVzaChtKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY29sbGFwc2VkICYmIChjb2xsYXBzZWQuZnJvbSB8fCAwKSA9PSBwb3MpIHtcbiAgICAgICAgICBidWlsZENvbGxhcHNlZFNwYW4oYnVpbGRlciwgKGNvbGxhcHNlZC50byA9PSBudWxsID8gbGVuIDogY29sbGFwc2VkLnRvKSAtIHBvcyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29sbGFwc2VkLm1hcmtlciwgY29sbGFwc2VkLmZyb20gPT0gbnVsbCk7XG4gICAgICAgICAgaWYgKGNvbGxhcHNlZC50byA9PSBudWxsKSByZXR1cm4gY29sbGFwc2VkLm1hcmtlci5maW5kKCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFjb2xsYXBzZWQgJiYgZm91bmRCb29rbWFya3MubGVuZ3RoKSBmb3IgKHZhciBqID0gMDsgaiA8IGZvdW5kQm9va21hcmtzLmxlbmd0aDsgKytqKVxuICAgICAgICAgIGJ1aWxkQ29sbGFwc2VkU3BhbihidWlsZGVyLCAwLCBmb3VuZEJvb2ttYXJrc1tqXSk7XG4gICAgICB9XG4gICAgICBpZiAocG9zID49IGxlbikgYnJlYWs7XG5cbiAgICAgIHZhciB1cHRvID0gTWF0aC5taW4obGVuLCBuZXh0Q2hhbmdlKTtcbiAgICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICAgIGlmICh0ZXh0KSB7XG4gICAgICAgICAgdmFyIGVuZCA9IHBvcyArIHRleHQubGVuZ3RoO1xuICAgICAgICAgIGlmICghY29sbGFwc2VkKSB7XG4gICAgICAgICAgICB2YXIgdG9rZW5UZXh0ID0gZW5kID4gdXB0byA/IHRleHQuc2xpY2UoMCwgdXB0byAtIHBvcykgOiB0ZXh0O1xuICAgICAgICAgICAgYnVpbGRlci5hZGRUb2tlbihidWlsZGVyLCB0b2tlblRleHQsIHN0eWxlID8gc3R5bGUgKyBzcGFuU3R5bGUgOiBzcGFuU3R5bGUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNwYW5TdGFydFN0eWxlLCBwb3MgKyB0b2tlblRleHQubGVuZ3RoID09IG5leHRDaGFuZ2UgPyBzcGFuRW5kU3R5bGUgOiBcIlwiLCB0aXRsZSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChlbmQgPj0gdXB0bykge3RleHQgPSB0ZXh0LnNsaWNlKHVwdG8gLSBwb3MpOyBwb3MgPSB1cHRvOyBicmVhazt9XG4gICAgICAgICAgcG9zID0gZW5kO1xuICAgICAgICAgIHNwYW5TdGFydFN0eWxlID0gXCJcIjtcbiAgICAgICAgfVxuICAgICAgICB0ZXh0ID0gYWxsVGV4dC5zbGljZShhdCwgYXQgPSBzdHlsZXNbaSsrXSk7XG4gICAgICAgIHN0eWxlID0gaW50ZXJwcmV0VG9rZW5TdHlsZShzdHlsZXNbaSsrXSwgYnVpbGRlcik7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gRE9DVU1FTlQgREFUQSBTVFJVQ1RVUkVcblxuICBmdW5jdGlvbiB1cGRhdGVEb2MoZG9jLCBjaGFuZ2UsIG1hcmtlZFNwYW5zLCBzZWxBZnRlciwgZXN0aW1hdGVIZWlnaHQpIHtcbiAgICBmdW5jdGlvbiBzcGFuc0ZvcihuKSB7cmV0dXJuIG1hcmtlZFNwYW5zID8gbWFya2VkU3BhbnNbbl0gOiBudWxsO31cbiAgICBmdW5jdGlvbiB1cGRhdGUobGluZSwgdGV4dCwgc3BhbnMpIHtcbiAgICAgIHVwZGF0ZUxpbmUobGluZSwgdGV4dCwgc3BhbnMsIGVzdGltYXRlSGVpZ2h0KTtcbiAgICAgIHNpZ25hbExhdGVyKGxpbmUsIFwiY2hhbmdlXCIsIGxpbmUsIGNoYW5nZSk7XG4gICAgfVxuXG4gICAgdmFyIGZyb20gPSBjaGFuZ2UuZnJvbSwgdG8gPSBjaGFuZ2UudG8sIHRleHQgPSBjaGFuZ2UudGV4dDtcbiAgICB2YXIgZmlyc3RMaW5lID0gZ2V0TGluZShkb2MsIGZyb20ubGluZSksIGxhc3RMaW5lID0gZ2V0TGluZShkb2MsIHRvLmxpbmUpO1xuICAgIHZhciBsYXN0VGV4dCA9IGxzdCh0ZXh0KSwgbGFzdFNwYW5zID0gc3BhbnNGb3IodGV4dC5sZW5ndGggLSAxKSwgbmxpbmVzID0gdG8ubGluZSAtIGZyb20ubGluZTtcblxuICAgIC8vIEZpcnN0IGFkanVzdCB0aGUgbGluZSBzdHJ1Y3R1cmVcbiAgICBpZiAoZnJvbS5jaCA9PSAwICYmIHRvLmNoID09IDAgJiYgbGFzdFRleHQgPT0gXCJcIiAmJlxuICAgICAgICAoIWRvYy5jbSB8fCBkb2MuY20ub3B0aW9ucy53aG9sZUxpbmVVcGRhdGVCZWZvcmUpKSB7XG4gICAgICAvLyBUaGlzIGlzIGEgd2hvbGUtbGluZSByZXBsYWNlLiBUcmVhdGVkIHNwZWNpYWxseSB0byBtYWtlXG4gICAgICAvLyBzdXJlIGxpbmUgb2JqZWN0cyBtb3ZlIHRoZSB3YXkgdGhleSBhcmUgc3VwcG9zZWQgdG8uXG4gICAgICBmb3IgKHZhciBpID0gMCwgZSA9IHRleHQubGVuZ3RoIC0gMSwgYWRkZWQgPSBbXTsgaSA8IGU7ICsraSlcbiAgICAgICAgYWRkZWQucHVzaChuZXcgTGluZSh0ZXh0W2ldLCBzcGFuc0ZvcihpKSwgZXN0aW1hdGVIZWlnaHQpKTtcbiAgICAgIHVwZGF0ZShsYXN0TGluZSwgbGFzdExpbmUudGV4dCwgbGFzdFNwYW5zKTtcbiAgICAgIGlmIChubGluZXMpIGRvYy5yZW1vdmUoZnJvbS5saW5lLCBubGluZXMpO1xuICAgICAgaWYgKGFkZGVkLmxlbmd0aCkgZG9jLmluc2VydChmcm9tLmxpbmUsIGFkZGVkKTtcbiAgICB9IGVsc2UgaWYgKGZpcnN0TGluZSA9PSBsYXN0TGluZSkge1xuICAgICAgaWYgKHRleHQubGVuZ3RoID09IDEpIHtcbiAgICAgICAgdXBkYXRlKGZpcnN0TGluZSwgZmlyc3RMaW5lLnRleHQuc2xpY2UoMCwgZnJvbS5jaCkgKyBsYXN0VGV4dCArIGZpcnN0TGluZS50ZXh0LnNsaWNlKHRvLmNoKSwgbGFzdFNwYW5zKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGZvciAodmFyIGFkZGVkID0gW10sIGkgPSAxLCBlID0gdGV4dC5sZW5ndGggLSAxOyBpIDwgZTsgKytpKVxuICAgICAgICAgIGFkZGVkLnB1c2gobmV3IExpbmUodGV4dFtpXSwgc3BhbnNGb3IoaSksIGVzdGltYXRlSGVpZ2h0KSk7XG4gICAgICAgIGFkZGVkLnB1c2gobmV3IExpbmUobGFzdFRleHQgKyBmaXJzdExpbmUudGV4dC5zbGljZSh0by5jaCksIGxhc3RTcGFucywgZXN0aW1hdGVIZWlnaHQpKTtcbiAgICAgICAgdXBkYXRlKGZpcnN0TGluZSwgZmlyc3RMaW5lLnRleHQuc2xpY2UoMCwgZnJvbS5jaCkgKyB0ZXh0WzBdLCBzcGFuc0ZvcigwKSk7XG4gICAgICAgIGRvYy5pbnNlcnQoZnJvbS5saW5lICsgMSwgYWRkZWQpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAodGV4dC5sZW5ndGggPT0gMSkge1xuICAgICAgdXBkYXRlKGZpcnN0TGluZSwgZmlyc3RMaW5lLnRleHQuc2xpY2UoMCwgZnJvbS5jaCkgKyB0ZXh0WzBdICsgbGFzdExpbmUudGV4dC5zbGljZSh0by5jaCksIHNwYW5zRm9yKDApKTtcbiAgICAgIGRvYy5yZW1vdmUoZnJvbS5saW5lICsgMSwgbmxpbmVzKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdXBkYXRlKGZpcnN0TGluZSwgZmlyc3RMaW5lLnRleHQuc2xpY2UoMCwgZnJvbS5jaCkgKyB0ZXh0WzBdLCBzcGFuc0ZvcigwKSk7XG4gICAgICB1cGRhdGUobGFzdExpbmUsIGxhc3RUZXh0ICsgbGFzdExpbmUudGV4dC5zbGljZSh0by5jaCksIGxhc3RTcGFucyk7XG4gICAgICBmb3IgKHZhciBpID0gMSwgZSA9IHRleHQubGVuZ3RoIC0gMSwgYWRkZWQgPSBbXTsgaSA8IGU7ICsraSlcbiAgICAgICAgYWRkZWQucHVzaChuZXcgTGluZSh0ZXh0W2ldLCBzcGFuc0ZvcihpKSwgZXN0aW1hdGVIZWlnaHQpKTtcbiAgICAgIGlmIChubGluZXMgPiAxKSBkb2MucmVtb3ZlKGZyb20ubGluZSArIDEsIG5saW5lcyAtIDEpO1xuICAgICAgZG9jLmluc2VydChmcm9tLmxpbmUgKyAxLCBhZGRlZCk7XG4gICAgfVxuXG4gICAgc2lnbmFsTGF0ZXIoZG9jLCBcImNoYW5nZVwiLCBkb2MsIGNoYW5nZSk7XG4gICAgc2V0U2VsZWN0aW9uKGRvYywgc2VsQWZ0ZXIuYW5jaG9yLCBzZWxBZnRlci5oZWFkLCBudWxsLCB0cnVlKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIExlYWZDaHVuayhsaW5lcykge1xuICAgIHRoaXMubGluZXMgPSBsaW5lcztcbiAgICB0aGlzLnBhcmVudCA9IG51bGw7XG4gICAgZm9yICh2YXIgaSA9IDAsIGUgPSBsaW5lcy5sZW5ndGgsIGhlaWdodCA9IDA7IGkgPCBlOyArK2kpIHtcbiAgICAgIGxpbmVzW2ldLnBhcmVudCA9IHRoaXM7XG4gICAgICBoZWlnaHQgKz0gbGluZXNbaV0uaGVpZ2h0O1xuICAgIH1cbiAgICB0aGlzLmhlaWdodCA9IGhlaWdodDtcbiAgfVxuXG4gIExlYWZDaHVuay5wcm90b3R5cGUgPSB7XG4gICAgY2h1bmtTaXplOiBmdW5jdGlvbigpIHsgcmV0dXJuIHRoaXMubGluZXMubGVuZ3RoOyB9LFxuICAgIHJlbW92ZUlubmVyOiBmdW5jdGlvbihhdCwgbikge1xuICAgICAgZm9yICh2YXIgaSA9IGF0LCBlID0gYXQgKyBuOyBpIDwgZTsgKytpKSB7XG4gICAgICAgIHZhciBsaW5lID0gdGhpcy5saW5lc1tpXTtcbiAgICAgICAgdGhpcy5oZWlnaHQgLT0gbGluZS5oZWlnaHQ7XG4gICAgICAgIGNsZWFuVXBMaW5lKGxpbmUpO1xuICAgICAgICBzaWduYWxMYXRlcihsaW5lLCBcImRlbGV0ZVwiKTtcbiAgICAgIH1cbiAgICAgIHRoaXMubGluZXMuc3BsaWNlKGF0LCBuKTtcbiAgICB9LFxuICAgIGNvbGxhcHNlOiBmdW5jdGlvbihsaW5lcykge1xuICAgICAgbGluZXMuc3BsaWNlLmFwcGx5KGxpbmVzLCBbbGluZXMubGVuZ3RoLCAwXS5jb25jYXQodGhpcy5saW5lcykpO1xuICAgIH0sXG4gICAgaW5zZXJ0SW5uZXI6IGZ1bmN0aW9uKGF0LCBsaW5lcywgaGVpZ2h0KSB7XG4gICAgICB0aGlzLmhlaWdodCArPSBoZWlnaHQ7XG4gICAgICB0aGlzLmxpbmVzID0gdGhpcy5saW5lcy5zbGljZSgwLCBhdCkuY29uY2F0KGxpbmVzKS5jb25jYXQodGhpcy5saW5lcy5zbGljZShhdCkpO1xuICAgICAgZm9yICh2YXIgaSA9IDAsIGUgPSBsaW5lcy5sZW5ndGg7IGkgPCBlOyArK2kpIGxpbmVzW2ldLnBhcmVudCA9IHRoaXM7XG4gICAgfSxcbiAgICBpdGVyTjogZnVuY3Rpb24oYXQsIG4sIG9wKSB7XG4gICAgICBmb3IgKHZhciBlID0gYXQgKyBuOyBhdCA8IGU7ICsrYXQpXG4gICAgICAgIGlmIChvcCh0aGlzLmxpbmVzW2F0XSkpIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfTtcblxuICBmdW5jdGlvbiBCcmFuY2hDaHVuayhjaGlsZHJlbikge1xuICAgIHRoaXMuY2hpbGRyZW4gPSBjaGlsZHJlbjtcbiAgICB2YXIgc2l6ZSA9IDAsIGhlaWdodCA9IDA7XG4gICAgZm9yICh2YXIgaSA9IDAsIGUgPSBjaGlsZHJlbi5sZW5ndGg7IGkgPCBlOyArK2kpIHtcbiAgICAgIHZhciBjaCA9IGNoaWxkcmVuW2ldO1xuICAgICAgc2l6ZSArPSBjaC5jaHVua1NpemUoKTsgaGVpZ2h0ICs9IGNoLmhlaWdodDtcbiAgICAgIGNoLnBhcmVudCA9IHRoaXM7XG4gICAgfVxuICAgIHRoaXMuc2l6ZSA9IHNpemU7XG4gICAgdGhpcy5oZWlnaHQgPSBoZWlnaHQ7XG4gICAgdGhpcy5wYXJlbnQgPSBudWxsO1xuICB9XG5cbiAgQnJhbmNoQ2h1bmsucHJvdG90eXBlID0ge1xuICAgIGNodW5rU2l6ZTogZnVuY3Rpb24oKSB7IHJldHVybiB0aGlzLnNpemU7IH0sXG4gICAgcmVtb3ZlSW5uZXI6IGZ1bmN0aW9uKGF0LCBuKSB7XG4gICAgICB0aGlzLnNpemUgLT0gbjtcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdGhpcy5jaGlsZHJlbi5sZW5ndGg7ICsraSkge1xuICAgICAgICB2YXIgY2hpbGQgPSB0aGlzLmNoaWxkcmVuW2ldLCBzeiA9IGNoaWxkLmNodW5rU2l6ZSgpO1xuICAgICAgICBpZiAoYXQgPCBzeikge1xuICAgICAgICAgIHZhciBybSA9IE1hdGgubWluKG4sIHN6IC0gYXQpLCBvbGRIZWlnaHQgPSBjaGlsZC5oZWlnaHQ7XG4gICAgICAgICAgY2hpbGQucmVtb3ZlSW5uZXIoYXQsIHJtKTtcbiAgICAgICAgICB0aGlzLmhlaWdodCAtPSBvbGRIZWlnaHQgLSBjaGlsZC5oZWlnaHQ7XG4gICAgICAgICAgaWYgKHN6ID09IHJtKSB7IHRoaXMuY2hpbGRyZW4uc3BsaWNlKGktLSwgMSk7IGNoaWxkLnBhcmVudCA9IG51bGw7IH1cbiAgICAgICAgICBpZiAoKG4gLT0gcm0pID09IDApIGJyZWFrO1xuICAgICAgICAgIGF0ID0gMDtcbiAgICAgICAgfSBlbHNlIGF0IC09IHN6O1xuICAgICAgfVxuICAgICAgaWYgKHRoaXMuc2l6ZSAtIG4gPCAyNSkge1xuICAgICAgICB2YXIgbGluZXMgPSBbXTtcbiAgICAgICAgdGhpcy5jb2xsYXBzZShsaW5lcyk7XG4gICAgICAgIHRoaXMuY2hpbGRyZW4gPSBbbmV3IExlYWZDaHVuayhsaW5lcyldO1xuICAgICAgICB0aGlzLmNoaWxkcmVuWzBdLnBhcmVudCA9IHRoaXM7XG4gICAgICB9XG4gICAgfSxcbiAgICBjb2xsYXBzZTogZnVuY3Rpb24obGluZXMpIHtcbiAgICAgIGZvciAodmFyIGkgPSAwLCBlID0gdGhpcy5jaGlsZHJlbi5sZW5ndGg7IGkgPCBlOyArK2kpIHRoaXMuY2hpbGRyZW5baV0uY29sbGFwc2UobGluZXMpO1xuICAgIH0sXG4gICAgaW5zZXJ0SW5uZXI6IGZ1bmN0aW9uKGF0LCBsaW5lcywgaGVpZ2h0KSB7XG4gICAgICB0aGlzLnNpemUgKz0gbGluZXMubGVuZ3RoO1xuICAgICAgdGhpcy5oZWlnaHQgKz0gaGVpZ2h0O1xuICAgICAgZm9yICh2YXIgaSA9IDAsIGUgPSB0aGlzLmNoaWxkcmVuLmxlbmd0aDsgaSA8IGU7ICsraSkge1xuICAgICAgICB2YXIgY2hpbGQgPSB0aGlzLmNoaWxkcmVuW2ldLCBzeiA9IGNoaWxkLmNodW5rU2l6ZSgpO1xuICAgICAgICBpZiAoYXQgPD0gc3opIHtcbiAgICAgICAgICBjaGlsZC5pbnNlcnRJbm5lcihhdCwgbGluZXMsIGhlaWdodCk7XG4gICAgICAgICAgaWYgKGNoaWxkLmxpbmVzICYmIGNoaWxkLmxpbmVzLmxlbmd0aCA+IDUwKSB7XG4gICAgICAgICAgICB3aGlsZSAoY2hpbGQubGluZXMubGVuZ3RoID4gNTApIHtcbiAgICAgICAgICAgICAgdmFyIHNwaWxsZWQgPSBjaGlsZC5saW5lcy5zcGxpY2UoY2hpbGQubGluZXMubGVuZ3RoIC0gMjUsIDI1KTtcbiAgICAgICAgICAgICAgdmFyIG5ld2xlYWYgPSBuZXcgTGVhZkNodW5rKHNwaWxsZWQpO1xuICAgICAgICAgICAgICBjaGlsZC5oZWlnaHQgLT0gbmV3bGVhZi5oZWlnaHQ7XG4gICAgICAgICAgICAgIHRoaXMuY2hpbGRyZW4uc3BsaWNlKGkgKyAxLCAwLCBuZXdsZWFmKTtcbiAgICAgICAgICAgICAgbmV3bGVhZi5wYXJlbnQgPSB0aGlzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5tYXliZVNwaWxsKCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICAgIGF0IC09IHN6O1xuICAgICAgfVxuICAgIH0sXG4gICAgbWF5YmVTcGlsbDogZnVuY3Rpb24oKSB7XG4gICAgICBpZiAodGhpcy5jaGlsZHJlbi5sZW5ndGggPD0gMTApIHJldHVybjtcbiAgICAgIHZhciBtZSA9IHRoaXM7XG4gICAgICBkbyB7XG4gICAgICAgIHZhciBzcGlsbGVkID0gbWUuY2hpbGRyZW4uc3BsaWNlKG1lLmNoaWxkcmVuLmxlbmd0aCAtIDUsIDUpO1xuICAgICAgICB2YXIgc2libGluZyA9IG5ldyBCcmFuY2hDaHVuayhzcGlsbGVkKTtcbiAgICAgICAgaWYgKCFtZS5wYXJlbnQpIHsgLy8gQmVjb21lIHRoZSBwYXJlbnQgbm9kZVxuICAgICAgICAgIHZhciBjb3B5ID0gbmV3IEJyYW5jaENodW5rKG1lLmNoaWxkcmVuKTtcbiAgICAgICAgICBjb3B5LnBhcmVudCA9IG1lO1xuICAgICAgICAgIG1lLmNoaWxkcmVuID0gW2NvcHksIHNpYmxpbmddO1xuICAgICAgICAgIG1lID0gY29weTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBtZS5zaXplIC09IHNpYmxpbmcuc2l6ZTtcbiAgICAgICAgICBtZS5oZWlnaHQgLT0gc2libGluZy5oZWlnaHQ7XG4gICAgICAgICAgdmFyIG15SW5kZXggPSBpbmRleE9mKG1lLnBhcmVudC5jaGlsZHJlbiwgbWUpO1xuICAgICAgICAgIG1lLnBhcmVudC5jaGlsZHJlbi5zcGxpY2UobXlJbmRleCArIDEsIDAsIHNpYmxpbmcpO1xuICAgICAgICB9XG4gICAgICAgIHNpYmxpbmcucGFyZW50ID0gbWUucGFyZW50O1xuICAgICAgfSB3aGlsZSAobWUuY2hpbGRyZW4ubGVuZ3RoID4gMTApO1xuICAgICAgbWUucGFyZW50Lm1heWJlU3BpbGwoKTtcbiAgICB9LFxuICAgIGl0ZXJOOiBmdW5jdGlvbihhdCwgbiwgb3ApIHtcbiAgICAgIGZvciAodmFyIGkgPSAwLCBlID0gdGhpcy5jaGlsZHJlbi5sZW5ndGg7IGkgPCBlOyArK2kpIHtcbiAgICAgICAgdmFyIGNoaWxkID0gdGhpcy5jaGlsZHJlbltpXSwgc3ogPSBjaGlsZC5jaHVua1NpemUoKTtcbiAgICAgICAgaWYgKGF0IDwgc3opIHtcbiAgICAgICAgICB2YXIgdXNlZCA9IE1hdGgubWluKG4sIHN6IC0gYXQpO1xuICAgICAgICAgIGlmIChjaGlsZC5pdGVyTihhdCwgdXNlZCwgb3ApKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICBpZiAoKG4gLT0gdXNlZCkgPT0gMCkgYnJlYWs7XG4gICAgICAgICAgYXQgPSAwO1xuICAgICAgICB9IGVsc2UgYXQgLT0gc3o7XG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIHZhciBuZXh0RG9jSWQgPSAwO1xuICB2YXIgRG9jID0gQ29kZU1pcnJvci5Eb2MgPSBmdW5jdGlvbih0ZXh0LCBtb2RlLCBmaXJzdExpbmUpIHtcbiAgICBpZiAoISh0aGlzIGluc3RhbmNlb2YgRG9jKSkgcmV0dXJuIG5ldyBEb2ModGV4dCwgbW9kZSwgZmlyc3RMaW5lKTtcbiAgICBpZiAoZmlyc3RMaW5lID09IG51bGwpIGZpcnN0TGluZSA9IDA7XG5cbiAgICBCcmFuY2hDaHVuay5jYWxsKHRoaXMsIFtuZXcgTGVhZkNodW5rKFtuZXcgTGluZShcIlwiLCBudWxsKV0pXSk7XG4gICAgdGhpcy5maXJzdCA9IGZpcnN0TGluZTtcbiAgICB0aGlzLnNjcm9sbFRvcCA9IHRoaXMuc2Nyb2xsTGVmdCA9IDA7XG4gICAgdGhpcy5jYW50RWRpdCA9IGZhbHNlO1xuICAgIHRoaXMuaGlzdG9yeSA9IG1ha2VIaXN0b3J5KCk7XG4gICAgdGhpcy5jbGVhbkdlbmVyYXRpb24gPSAxO1xuICAgIHRoaXMuZnJvbnRpZXIgPSBmaXJzdExpbmU7XG4gICAgdmFyIHN0YXJ0ID0gUG9zKGZpcnN0TGluZSwgMCk7XG4gICAgdGhpcy5zZWwgPSB7ZnJvbTogc3RhcnQsIHRvOiBzdGFydCwgaGVhZDogc3RhcnQsIGFuY2hvcjogc3RhcnQsIHNoaWZ0OiBmYWxzZSwgZXh0ZW5kOiBmYWxzZSwgZ29hbENvbHVtbjogbnVsbH07XG4gICAgdGhpcy5pZCA9ICsrbmV4dERvY0lkO1xuICAgIHRoaXMubW9kZU9wdGlvbiA9IG1vZGU7XG5cbiAgICBpZiAodHlwZW9mIHRleHQgPT0gXCJzdHJpbmdcIikgdGV4dCA9IHNwbGl0TGluZXModGV4dCk7XG4gICAgdXBkYXRlRG9jKHRoaXMsIHtmcm9tOiBzdGFydCwgdG86IHN0YXJ0LCB0ZXh0OiB0ZXh0fSwgbnVsbCwge2hlYWQ6IHN0YXJ0LCBhbmNob3I6IHN0YXJ0fSk7XG4gIH07XG5cbiAgRG9jLnByb3RvdHlwZSA9IGNyZWF0ZU9iaihCcmFuY2hDaHVuay5wcm90b3R5cGUsIHtcbiAgICBjb25zdHJ1Y3RvcjogRG9jLFxuICAgIGl0ZXI6IGZ1bmN0aW9uKGZyb20sIHRvLCBvcCkge1xuICAgICAgaWYgKG9wKSB0aGlzLml0ZXJOKGZyb20gLSB0aGlzLmZpcnN0LCB0byAtIGZyb20sIG9wKTtcbiAgICAgIGVsc2UgdGhpcy5pdGVyTih0aGlzLmZpcnN0LCB0aGlzLmZpcnN0ICsgdGhpcy5zaXplLCBmcm9tKTtcbiAgICB9LFxuXG4gICAgaW5zZXJ0OiBmdW5jdGlvbihhdCwgbGluZXMpIHtcbiAgICAgIHZhciBoZWlnaHQgPSAwO1xuICAgICAgZm9yICh2YXIgaSA9IDAsIGUgPSBsaW5lcy5sZW5ndGg7IGkgPCBlOyArK2kpIGhlaWdodCArPSBsaW5lc1tpXS5oZWlnaHQ7XG4gICAgICB0aGlzLmluc2VydElubmVyKGF0IC0gdGhpcy5maXJzdCwgbGluZXMsIGhlaWdodCk7XG4gICAgfSxcbiAgICByZW1vdmU6IGZ1bmN0aW9uKGF0LCBuKSB7IHRoaXMucmVtb3ZlSW5uZXIoYXQgLSB0aGlzLmZpcnN0LCBuKTsgfSxcblxuICAgIGdldFZhbHVlOiBmdW5jdGlvbihsaW5lU2VwKSB7XG4gICAgICB2YXIgbGluZXMgPSBnZXRMaW5lcyh0aGlzLCB0aGlzLmZpcnN0LCB0aGlzLmZpcnN0ICsgdGhpcy5zaXplKTtcbiAgICAgIGlmIChsaW5lU2VwID09PSBmYWxzZSkgcmV0dXJuIGxpbmVzO1xuICAgICAgcmV0dXJuIGxpbmVzLmpvaW4obGluZVNlcCB8fCBcIlxcblwiKTtcbiAgICB9LFxuICAgIHNldFZhbHVlOiBmdW5jdGlvbihjb2RlKSB7XG4gICAgICB2YXIgdG9wID0gUG9zKHRoaXMuZmlyc3QsIDApLCBsYXN0ID0gdGhpcy5maXJzdCArIHRoaXMuc2l6ZSAtIDE7XG4gICAgICBtYWtlQ2hhbmdlKHRoaXMsIHtmcm9tOiB0b3AsIHRvOiBQb3MobGFzdCwgZ2V0TGluZSh0aGlzLCBsYXN0KS50ZXh0Lmxlbmd0aCksXG4gICAgICAgICAgICAgICAgICAgICAgICB0ZXh0OiBzcGxpdExpbmVzKGNvZGUpLCBvcmlnaW46IFwic2V0VmFsdWVcIn0sXG4gICAgICAgICAgICAgICAgIHtoZWFkOiB0b3AsIGFuY2hvcjogdG9wfSwgdHJ1ZSk7XG4gICAgfSxcbiAgICByZXBsYWNlUmFuZ2U6IGZ1bmN0aW9uKGNvZGUsIGZyb20sIHRvLCBvcmlnaW4pIHtcbiAgICAgIGZyb20gPSBjbGlwUG9zKHRoaXMsIGZyb20pO1xuICAgICAgdG8gPSB0byA/IGNsaXBQb3ModGhpcywgdG8pIDogZnJvbTtcbiAgICAgIHJlcGxhY2VSYW5nZSh0aGlzLCBjb2RlLCBmcm9tLCB0bywgb3JpZ2luKTtcbiAgICB9LFxuICAgIGdldFJhbmdlOiBmdW5jdGlvbihmcm9tLCB0bywgbGluZVNlcCkge1xuICAgICAgdmFyIGxpbmVzID0gZ2V0QmV0d2Vlbih0aGlzLCBjbGlwUG9zKHRoaXMsIGZyb20pLCBjbGlwUG9zKHRoaXMsIHRvKSk7XG4gICAgICBpZiAobGluZVNlcCA9PT0gZmFsc2UpIHJldHVybiBsaW5lcztcbiAgICAgIHJldHVybiBsaW5lcy5qb2luKGxpbmVTZXAgfHwgXCJcXG5cIik7XG4gICAgfSxcblxuICAgIGdldExpbmU6IGZ1bmN0aW9uKGxpbmUpIHt2YXIgbCA9IHRoaXMuZ2V0TGluZUhhbmRsZShsaW5lKTsgcmV0dXJuIGwgJiYgbC50ZXh0O30sXG4gICAgc2V0TGluZTogZnVuY3Rpb24obGluZSwgdGV4dCkge1xuICAgICAgaWYgKGlzTGluZSh0aGlzLCBsaW5lKSlcbiAgICAgICAgcmVwbGFjZVJhbmdlKHRoaXMsIHRleHQsIFBvcyhsaW5lLCAwKSwgY2xpcFBvcyh0aGlzLCBQb3MobGluZSkpKTtcbiAgICB9LFxuICAgIHJlbW92ZUxpbmU6IGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgIGlmIChsaW5lKSByZXBsYWNlUmFuZ2UodGhpcywgXCJcIiwgY2xpcFBvcyh0aGlzLCBQb3MobGluZSAtIDEpKSwgY2xpcFBvcyh0aGlzLCBQb3MobGluZSkpKTtcbiAgICAgIGVsc2UgcmVwbGFjZVJhbmdlKHRoaXMsIFwiXCIsIFBvcygwLCAwKSwgY2xpcFBvcyh0aGlzLCBQb3MoMSwgMCkpKTtcbiAgICB9LFxuXG4gICAgZ2V0TGluZUhhbmRsZTogZnVuY3Rpb24obGluZSkge2lmIChpc0xpbmUodGhpcywgbGluZSkpIHJldHVybiBnZXRMaW5lKHRoaXMsIGxpbmUpO30sXG4gICAgZ2V0TGluZU51bWJlcjogZnVuY3Rpb24obGluZSkge3JldHVybiBsaW5lTm8obGluZSk7fSxcblxuICAgIGdldExpbmVIYW5kbGVWaXN1YWxTdGFydDogZnVuY3Rpb24obGluZSkge1xuICAgICAgaWYgKHR5cGVvZiBsaW5lID09IFwibnVtYmVyXCIpIGxpbmUgPSBnZXRMaW5lKHRoaXMsIGxpbmUpO1xuICAgICAgcmV0dXJuIHZpc3VhbExpbmUodGhpcywgbGluZSk7XG4gICAgfSxcblxuICAgIGxpbmVDb3VudDogZnVuY3Rpb24oKSB7cmV0dXJuIHRoaXMuc2l6ZTt9LFxuICAgIGZpcnN0TGluZTogZnVuY3Rpb24oKSB7cmV0dXJuIHRoaXMuZmlyc3Q7fSxcbiAgICBsYXN0TGluZTogZnVuY3Rpb24oKSB7cmV0dXJuIHRoaXMuZmlyc3QgKyB0aGlzLnNpemUgLSAxO30sXG5cbiAgICBjbGlwUG9zOiBmdW5jdGlvbihwb3MpIHtyZXR1cm4gY2xpcFBvcyh0aGlzLCBwb3MpO30sXG5cbiAgICBnZXRDdXJzb3I6IGZ1bmN0aW9uKHN0YXJ0KSB7XG4gICAgICB2YXIgc2VsID0gdGhpcy5zZWwsIHBvcztcbiAgICAgIGlmIChzdGFydCA9PSBudWxsIHx8IHN0YXJ0ID09IFwiaGVhZFwiKSBwb3MgPSBzZWwuaGVhZDtcbiAgICAgIGVsc2UgaWYgKHN0YXJ0ID09IFwiYW5jaG9yXCIpIHBvcyA9IHNlbC5hbmNob3I7XG4gICAgICBlbHNlIGlmIChzdGFydCA9PSBcImVuZFwiIHx8IHN0YXJ0ID09PSBmYWxzZSkgcG9zID0gc2VsLnRvO1xuICAgICAgZWxzZSBwb3MgPSBzZWwuZnJvbTtcbiAgICAgIHJldHVybiBjb3B5UG9zKHBvcyk7XG4gICAgfSxcbiAgICBzb21ldGhpbmdTZWxlY3RlZDogZnVuY3Rpb24oKSB7cmV0dXJuICFwb3NFcSh0aGlzLnNlbC5oZWFkLCB0aGlzLnNlbC5hbmNob3IpO30sXG5cbiAgICBzZXRDdXJzb3I6IGRvY09wZXJhdGlvbihmdW5jdGlvbihsaW5lLCBjaCwgZXh0ZW5kKSB7XG4gICAgICB2YXIgcG9zID0gY2xpcFBvcyh0aGlzLCB0eXBlb2YgbGluZSA9PSBcIm51bWJlclwiID8gUG9zKGxpbmUsIGNoIHx8IDApIDogbGluZSk7XG4gICAgICBpZiAoZXh0ZW5kKSBleHRlbmRTZWxlY3Rpb24odGhpcywgcG9zKTtcbiAgICAgIGVsc2Ugc2V0U2VsZWN0aW9uKHRoaXMsIHBvcywgcG9zKTtcbiAgICB9KSxcbiAgICBzZXRTZWxlY3Rpb246IGRvY09wZXJhdGlvbihmdW5jdGlvbihhbmNob3IsIGhlYWQsIGJpYXMpIHtcbiAgICAgIHNldFNlbGVjdGlvbih0aGlzLCBjbGlwUG9zKHRoaXMsIGFuY2hvciksIGNsaXBQb3ModGhpcywgaGVhZCB8fCBhbmNob3IpLCBiaWFzKTtcbiAgICB9KSxcbiAgICBleHRlbmRTZWxlY3Rpb246IGRvY09wZXJhdGlvbihmdW5jdGlvbihmcm9tLCB0bywgYmlhcykge1xuICAgICAgZXh0ZW5kU2VsZWN0aW9uKHRoaXMsIGNsaXBQb3ModGhpcywgZnJvbSksIHRvICYmIGNsaXBQb3ModGhpcywgdG8pLCBiaWFzKTtcbiAgICB9KSxcblxuICAgIGdldFNlbGVjdGlvbjogZnVuY3Rpb24obGluZVNlcCkge3JldHVybiB0aGlzLmdldFJhbmdlKHRoaXMuc2VsLmZyb20sIHRoaXMuc2VsLnRvLCBsaW5lU2VwKTt9LFxuICAgIHJlcGxhY2VTZWxlY3Rpb246IGZ1bmN0aW9uKGNvZGUsIGNvbGxhcHNlLCBvcmlnaW4pIHtcbiAgICAgIG1ha2VDaGFuZ2UodGhpcywge2Zyb206IHRoaXMuc2VsLmZyb20sIHRvOiB0aGlzLnNlbC50bywgdGV4dDogc3BsaXRMaW5lcyhjb2RlKSwgb3JpZ2luOiBvcmlnaW59LCBjb2xsYXBzZSB8fCBcImFyb3VuZFwiKTtcbiAgICB9LFxuICAgIHVuZG86IGRvY09wZXJhdGlvbihmdW5jdGlvbigpIHttYWtlQ2hhbmdlRnJvbUhpc3RvcnkodGhpcywgXCJ1bmRvXCIpO30pLFxuICAgIHJlZG86IGRvY09wZXJhdGlvbihmdW5jdGlvbigpIHttYWtlQ2hhbmdlRnJvbUhpc3RvcnkodGhpcywgXCJyZWRvXCIpO30pLFxuXG4gICAgc2V0RXh0ZW5kaW5nOiBmdW5jdGlvbih2YWwpIHt0aGlzLnNlbC5leHRlbmQgPSB2YWw7fSxcblxuICAgIGhpc3RvcnlTaXplOiBmdW5jdGlvbigpIHtcbiAgICAgIHZhciBoaXN0ID0gdGhpcy5oaXN0b3J5O1xuICAgICAgcmV0dXJuIHt1bmRvOiBoaXN0LmRvbmUubGVuZ3RoLCByZWRvOiBoaXN0LnVuZG9uZS5sZW5ndGh9O1xuICAgIH0sXG4gICAgY2xlYXJIaXN0b3J5OiBmdW5jdGlvbigpIHt0aGlzLmhpc3RvcnkgPSBtYWtlSGlzdG9yeSh0aGlzLmhpc3RvcnkubWF4R2VuZXJhdGlvbik7fSxcblxuICAgIG1hcmtDbGVhbjogZnVuY3Rpb24oKSB7XG4gICAgICB0aGlzLmNsZWFuR2VuZXJhdGlvbiA9IHRoaXMuY2hhbmdlR2VuZXJhdGlvbih0cnVlKTtcbiAgICB9LFxuICAgIGNoYW5nZUdlbmVyYXRpb246IGZ1bmN0aW9uKGZvcmNlU3BsaXQpIHtcbiAgICAgIGlmIChmb3JjZVNwbGl0KVxuICAgICAgICB0aGlzLmhpc3RvcnkubGFzdE9wID0gdGhpcy5oaXN0b3J5Lmxhc3RPcmlnaW4gPSBudWxsO1xuICAgICAgcmV0dXJuIHRoaXMuaGlzdG9yeS5nZW5lcmF0aW9uO1xuICAgIH0sXG4gICAgaXNDbGVhbjogZnVuY3Rpb24gKGdlbikge1xuICAgICAgcmV0dXJuIHRoaXMuaGlzdG9yeS5nZW5lcmF0aW9uID09IChnZW4gfHwgdGhpcy5jbGVhbkdlbmVyYXRpb24pO1xuICAgIH0sXG5cbiAgICBnZXRIaXN0b3J5OiBmdW5jdGlvbigpIHtcbiAgICAgIHJldHVybiB7ZG9uZTogY29weUhpc3RvcnlBcnJheSh0aGlzLmhpc3RvcnkuZG9uZSksXG4gICAgICAgICAgICAgIHVuZG9uZTogY29weUhpc3RvcnlBcnJheSh0aGlzLmhpc3RvcnkudW5kb25lKX07XG4gICAgfSxcbiAgICBzZXRIaXN0b3J5OiBmdW5jdGlvbihoaXN0RGF0YSkge1xuICAgICAgdmFyIGhpc3QgPSB0aGlzLmhpc3RvcnkgPSBtYWtlSGlzdG9yeSh0aGlzLmhpc3RvcnkubWF4R2VuZXJhdGlvbik7XG4gICAgICBoaXN0LmRvbmUgPSBoaXN0RGF0YS5kb25lLnNsaWNlKDApO1xuICAgICAgaGlzdC51bmRvbmUgPSBoaXN0RGF0YS51bmRvbmUuc2xpY2UoMCk7XG4gICAgfSxcblxuICAgIG1hcmtUZXh0OiBmdW5jdGlvbihmcm9tLCB0bywgb3B0aW9ucykge1xuICAgICAgcmV0dXJuIG1hcmtUZXh0KHRoaXMsIGNsaXBQb3ModGhpcywgZnJvbSksIGNsaXBQb3ModGhpcywgdG8pLCBvcHRpb25zLCBcInJhbmdlXCIpO1xuICAgIH0sXG4gICAgc2V0Qm9va21hcms6IGZ1bmN0aW9uKHBvcywgb3B0aW9ucykge1xuICAgICAgdmFyIHJlYWxPcHRzID0ge3JlcGxhY2VkV2l0aDogb3B0aW9ucyAmJiAob3B0aW9ucy5ub2RlVHlwZSA9PSBudWxsID8gb3B0aW9ucy53aWRnZXQgOiBvcHRpb25zKSxcbiAgICAgICAgICAgICAgICAgICAgICBpbnNlcnRMZWZ0OiBvcHRpb25zICYmIG9wdGlvbnMuaW5zZXJ0TGVmdCxcbiAgICAgICAgICAgICAgICAgICAgICBjbGVhcldoZW5FbXB0eTogZmFsc2V9O1xuICAgICAgcG9zID0gY2xpcFBvcyh0aGlzLCBwb3MpO1xuICAgICAgcmV0dXJuIG1hcmtUZXh0KHRoaXMsIHBvcywgcG9zLCByZWFsT3B0cywgXCJib29rbWFya1wiKTtcbiAgICB9LFxuICAgIGZpbmRNYXJrc0F0OiBmdW5jdGlvbihwb3MpIHtcbiAgICAgIHBvcyA9IGNsaXBQb3ModGhpcywgcG9zKTtcbiAgICAgIHZhciBtYXJrZXJzID0gW10sIHNwYW5zID0gZ2V0TGluZSh0aGlzLCBwb3MubGluZSkubWFya2VkU3BhbnM7XG4gICAgICBpZiAoc3BhbnMpIGZvciAodmFyIGkgPSAwOyBpIDwgc3BhbnMubGVuZ3RoOyArK2kpIHtcbiAgICAgICAgdmFyIHNwYW4gPSBzcGFuc1tpXTtcbiAgICAgICAgaWYgKChzcGFuLmZyb20gPT0gbnVsbCB8fCBzcGFuLmZyb20gPD0gcG9zLmNoKSAmJlxuICAgICAgICAgICAgKHNwYW4udG8gPT0gbnVsbCB8fCBzcGFuLnRvID49IHBvcy5jaCkpXG4gICAgICAgICAgbWFya2Vycy5wdXNoKHNwYW4ubWFya2VyLnBhcmVudCB8fCBzcGFuLm1hcmtlcik7XG4gICAgICB9XG4gICAgICByZXR1cm4gbWFya2VycztcbiAgICB9LFxuICAgIGZpbmRNYXJrczogZnVuY3Rpb24oZnJvbSwgdG8pIHtcbiAgICAgIGZyb20gPSBjbGlwUG9zKHRoaXMsIGZyb20pOyB0byA9IGNsaXBQb3ModGhpcywgdG8pO1xuICAgICAgdmFyIGZvdW5kID0gW10sIGxpbmVObyA9IGZyb20ubGluZTtcbiAgICAgIHRoaXMuaXRlcihmcm9tLmxpbmUsIHRvLmxpbmUgKyAxLCBmdW5jdGlvbihsaW5lKSB7XG4gICAgICAgIHZhciBzcGFucyA9IGxpbmUubWFya2VkU3BhbnM7XG4gICAgICAgIGlmIChzcGFucykgZm9yICh2YXIgaSA9IDA7IGkgPCBzcGFucy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgIHZhciBzcGFuID0gc3BhbnNbaV07XG4gICAgICAgICAgaWYgKCEobGluZU5vID09IGZyb20ubGluZSAmJiBmcm9tLmNoID4gc3Bhbi50byB8fFxuICAgICAgICAgICAgICAgIHNwYW4uZnJvbSA9PSBudWxsICYmIGxpbmVObyAhPSBmcm9tLmxpbmV8fFxuICAgICAgICAgICAgICAgIGxpbmVObyA9PSB0by5saW5lICYmIHNwYW4uZnJvbSA+IHRvLmNoKSlcbiAgICAgICAgICAgIGZvdW5kLnB1c2goc3Bhbi5tYXJrZXIucGFyZW50IHx8IHNwYW4ubWFya2VyKTtcbiAgICAgICAgfVxuICAgICAgICArK2xpbmVObztcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIGZvdW5kO1xuICAgIH0sXG4gICAgZ2V0QWxsTWFya3M6IGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIG1hcmtlcnMgPSBbXTtcbiAgICAgIHRoaXMuaXRlcihmdW5jdGlvbihsaW5lKSB7XG4gICAgICAgIHZhciBzcHMgPSBsaW5lLm1hcmtlZFNwYW5zO1xuICAgICAgICBpZiAoc3BzKSBmb3IgKHZhciBpID0gMDsgaSA8IHNwcy5sZW5ndGg7ICsraSlcbiAgICAgICAgICBpZiAoc3BzW2ldLmZyb20gIT0gbnVsbCkgbWFya2Vycy5wdXNoKHNwc1tpXS5tYXJrZXIpO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4gbWFya2VycztcbiAgICB9LFxuXG4gICAgcG9zRnJvbUluZGV4OiBmdW5jdGlvbihvZmYpIHtcbiAgICAgIHZhciBjaCwgbGluZU5vID0gdGhpcy5maXJzdDtcbiAgICAgIHRoaXMuaXRlcihmdW5jdGlvbihsaW5lKSB7XG4gICAgICAgIHZhciBzeiA9IGxpbmUudGV4dC5sZW5ndGggKyAxO1xuICAgICAgICBpZiAoc3ogPiBvZmYpIHsgY2ggPSBvZmY7IHJldHVybiB0cnVlOyB9XG4gICAgICAgIG9mZiAtPSBzejtcbiAgICAgICAgKytsaW5lTm87XG4gICAgICB9KTtcbiAgICAgIHJldHVybiBjbGlwUG9zKHRoaXMsIFBvcyhsaW5lTm8sIGNoKSk7XG4gICAgfSxcbiAgICBpbmRleEZyb21Qb3M6IGZ1bmN0aW9uIChjb29yZHMpIHtcbiAgICAgIGNvb3JkcyA9IGNsaXBQb3ModGhpcywgY29vcmRzKTtcbiAgICAgIHZhciBpbmRleCA9IGNvb3Jkcy5jaDtcbiAgICAgIGlmIChjb29yZHMubGluZSA8IHRoaXMuZmlyc3QgfHwgY29vcmRzLmNoIDwgMCkgcmV0dXJuIDA7XG4gICAgICB0aGlzLml0ZXIodGhpcy5maXJzdCwgY29vcmRzLmxpbmUsIGZ1bmN0aW9uIChsaW5lKSB7XG4gICAgICAgIGluZGV4ICs9IGxpbmUudGV4dC5sZW5ndGggKyAxO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4gaW5kZXg7XG4gICAgfSxcblxuICAgIGNvcHk6IGZ1bmN0aW9uKGNvcHlIaXN0b3J5KSB7XG4gICAgICB2YXIgZG9jID0gbmV3IERvYyhnZXRMaW5lcyh0aGlzLCB0aGlzLmZpcnN0LCB0aGlzLmZpcnN0ICsgdGhpcy5zaXplKSwgdGhpcy5tb2RlT3B0aW9uLCB0aGlzLmZpcnN0KTtcbiAgICAgIGRvYy5zY3JvbGxUb3AgPSB0aGlzLnNjcm9sbFRvcDsgZG9jLnNjcm9sbExlZnQgPSB0aGlzLnNjcm9sbExlZnQ7XG4gICAgICBkb2Muc2VsID0ge2Zyb206IHRoaXMuc2VsLmZyb20sIHRvOiB0aGlzLnNlbC50bywgaGVhZDogdGhpcy5zZWwuaGVhZCwgYW5jaG9yOiB0aGlzLnNlbC5hbmNob3IsXG4gICAgICAgICAgICAgICAgIHNoaWZ0OiB0aGlzLnNlbC5zaGlmdCwgZXh0ZW5kOiBmYWxzZSwgZ29hbENvbHVtbjogdGhpcy5zZWwuZ29hbENvbHVtbn07XG4gICAgICBpZiAoY29weUhpc3RvcnkpIHtcbiAgICAgICAgZG9jLmhpc3RvcnkudW5kb0RlcHRoID0gdGhpcy5oaXN0b3J5LnVuZG9EZXB0aDtcbiAgICAgICAgZG9jLnNldEhpc3RvcnkodGhpcy5nZXRIaXN0b3J5KCkpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGRvYztcbiAgICB9LFxuXG4gICAgbGlua2VkRG9jOiBmdW5jdGlvbihvcHRpb25zKSB7XG4gICAgICBpZiAoIW9wdGlvbnMpIG9wdGlvbnMgPSB7fTtcbiAgICAgIHZhciBmcm9tID0gdGhpcy5maXJzdCwgdG8gPSB0aGlzLmZpcnN0ICsgdGhpcy5zaXplO1xuICAgICAgaWYgKG9wdGlvbnMuZnJvbSAhPSBudWxsICYmIG9wdGlvbnMuZnJvbSA+IGZyb20pIGZyb20gPSBvcHRpb25zLmZyb207XG4gICAgICBpZiAob3B0aW9ucy50byAhPSBudWxsICYmIG9wdGlvbnMudG8gPCB0bykgdG8gPSBvcHRpb25zLnRvO1xuICAgICAgdmFyIGNvcHkgPSBuZXcgRG9jKGdldExpbmVzKHRoaXMsIGZyb20sIHRvKSwgb3B0aW9ucy5tb2RlIHx8IHRoaXMubW9kZU9wdGlvbiwgZnJvbSk7XG4gICAgICBpZiAob3B0aW9ucy5zaGFyZWRIaXN0KSBjb3B5Lmhpc3RvcnkgPSB0aGlzLmhpc3Rvcnk7XG4gICAgICAodGhpcy5saW5rZWQgfHwgKHRoaXMubGlua2VkID0gW10pKS5wdXNoKHtkb2M6IGNvcHksIHNoYXJlZEhpc3Q6IG9wdGlvbnMuc2hhcmVkSGlzdH0pO1xuICAgICAgY29weS5saW5rZWQgPSBbe2RvYzogdGhpcywgaXNQYXJlbnQ6IHRydWUsIHNoYXJlZEhpc3Q6IG9wdGlvbnMuc2hhcmVkSGlzdH1dO1xuICAgICAgcmV0dXJuIGNvcHk7XG4gICAgfSxcbiAgICB1bmxpbmtEb2M6IGZ1bmN0aW9uKG90aGVyKSB7XG4gICAgICBpZiAob3RoZXIgaW5zdGFuY2VvZiBDb2RlTWlycm9yKSBvdGhlciA9IG90aGVyLmRvYztcbiAgICAgIGlmICh0aGlzLmxpbmtlZCkgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLmxpbmtlZC5sZW5ndGg7ICsraSkge1xuICAgICAgICB2YXIgbGluayA9IHRoaXMubGlua2VkW2ldO1xuICAgICAgICBpZiAobGluay5kb2MgIT0gb3RoZXIpIGNvbnRpbnVlO1xuICAgICAgICB0aGlzLmxpbmtlZC5zcGxpY2UoaSwgMSk7XG4gICAgICAgIG90aGVyLnVubGlua0RvYyh0aGlzKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICAvLyBJZiB0aGUgaGlzdG9yaWVzIHdlcmUgc2hhcmVkLCBzcGxpdCB0aGVtIGFnYWluXG4gICAgICBpZiAob3RoZXIuaGlzdG9yeSA9PSB0aGlzLmhpc3RvcnkpIHtcbiAgICAgICAgdmFyIHNwbGl0SWRzID0gW290aGVyLmlkXTtcbiAgICAgICAgbGlua2VkRG9jcyhvdGhlciwgZnVuY3Rpb24oZG9jKSB7c3BsaXRJZHMucHVzaChkb2MuaWQpO30sIHRydWUpO1xuICAgICAgICBvdGhlci5oaXN0b3J5ID0gbWFrZUhpc3RvcnkoKTtcbiAgICAgICAgb3RoZXIuaGlzdG9yeS5kb25lID0gY29weUhpc3RvcnlBcnJheSh0aGlzLmhpc3RvcnkuZG9uZSwgc3BsaXRJZHMpO1xuICAgICAgICBvdGhlci5oaXN0b3J5LnVuZG9uZSA9IGNvcHlIaXN0b3J5QXJyYXkodGhpcy5oaXN0b3J5LnVuZG9uZSwgc3BsaXRJZHMpO1xuICAgICAgfVxuICAgIH0sXG4gICAgaXRlckxpbmtlZERvY3M6IGZ1bmN0aW9uKGYpIHtsaW5rZWREb2NzKHRoaXMsIGYpO30sXG5cbiAgICBnZXRNb2RlOiBmdW5jdGlvbigpIHtyZXR1cm4gdGhpcy5tb2RlO30sXG4gICAgZ2V0RWRpdG9yOiBmdW5jdGlvbigpIHtyZXR1cm4gdGhpcy5jbTt9XG4gIH0pO1xuXG4gIERvYy5wcm90b3R5cGUuZWFjaExpbmUgPSBEb2MucHJvdG90eXBlLml0ZXI7XG5cbiAgLy8gVGhlIERvYyBtZXRob2RzIHRoYXQgc2hvdWxkIGJlIGF2YWlsYWJsZSBvbiBDb2RlTWlycm9yIGluc3RhbmNlc1xuICB2YXIgZG9udERlbGVnYXRlID0gXCJpdGVyIGluc2VydCByZW1vdmUgY29weSBnZXRFZGl0b3JcIi5zcGxpdChcIiBcIik7XG4gIGZvciAodmFyIHByb3AgaW4gRG9jLnByb3RvdHlwZSkgaWYgKERvYy5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkocHJvcCkgJiYgaW5kZXhPZihkb250RGVsZWdhdGUsIHByb3ApIDwgMClcbiAgICBDb2RlTWlycm9yLnByb3RvdHlwZVtwcm9wXSA9IChmdW5jdGlvbihtZXRob2QpIHtcbiAgICAgIHJldHVybiBmdW5jdGlvbigpIHtyZXR1cm4gbWV0aG9kLmFwcGx5KHRoaXMuZG9jLCBhcmd1bWVudHMpO307XG4gICAgfSkoRG9jLnByb3RvdHlwZVtwcm9wXSk7XG5cbiAgZXZlbnRNaXhpbihEb2MpO1xuXG4gIGZ1bmN0aW9uIGxpbmtlZERvY3MoZG9jLCBmLCBzaGFyZWRIaXN0T25seSkge1xuICAgIGZ1bmN0aW9uIHByb3BhZ2F0ZShkb2MsIHNraXAsIHNoYXJlZEhpc3QpIHtcbiAgICAgIGlmIChkb2MubGlua2VkKSBmb3IgKHZhciBpID0gMDsgaSA8IGRvYy5saW5rZWQubGVuZ3RoOyArK2kpIHtcbiAgICAgICAgdmFyIHJlbCA9IGRvYy5saW5rZWRbaV07XG4gICAgICAgIGlmIChyZWwuZG9jID09IHNraXApIGNvbnRpbnVlO1xuICAgICAgICB2YXIgc2hhcmVkID0gc2hhcmVkSGlzdCAmJiByZWwuc2hhcmVkSGlzdDtcbiAgICAgICAgaWYgKHNoYXJlZEhpc3RPbmx5ICYmICFzaGFyZWQpIGNvbnRpbnVlO1xuICAgICAgICBmKHJlbC5kb2MsIHNoYXJlZCk7XG4gICAgICAgIHByb3BhZ2F0ZShyZWwuZG9jLCBkb2MsIHNoYXJlZCk7XG4gICAgICB9XG4gICAgfVxuICAgIHByb3BhZ2F0ZShkb2MsIG51bGwsIHRydWUpO1xuICB9XG5cbiAgZnVuY3Rpb24gYXR0YWNoRG9jKGNtLCBkb2MpIHtcbiAgICBpZiAoZG9jLmNtKSB0aHJvdyBuZXcgRXJyb3IoXCJUaGlzIGRvY3VtZW50IGlzIGFscmVhZHkgaW4gdXNlLlwiKTtcbiAgICBjbS5kb2MgPSBkb2M7XG4gICAgZG9jLmNtID0gY207XG4gICAgZXN0aW1hdGVMaW5lSGVpZ2h0cyhjbSk7XG4gICAgbG9hZE1vZGUoY20pO1xuICAgIGlmICghY20ub3B0aW9ucy5saW5lV3JhcHBpbmcpIGNvbXB1dGVNYXhMZW5ndGgoY20pO1xuICAgIGNtLm9wdGlvbnMubW9kZSA9IGRvYy5tb2RlT3B0aW9uO1xuICAgIHJlZ0NoYW5nZShjbSk7XG4gIH1cblxuICAvLyBMSU5FIFVUSUxJVElFU1xuXG4gIGZ1bmN0aW9uIGdldExpbmUoY2h1bmssIG4pIHtcbiAgICBuIC09IGNodW5rLmZpcnN0O1xuICAgIHdoaWxlICghY2h1bmsubGluZXMpIHtcbiAgICAgIGZvciAodmFyIGkgPSAwOzsgKytpKSB7XG4gICAgICAgIHZhciBjaGlsZCA9IGNodW5rLmNoaWxkcmVuW2ldLCBzeiA9IGNoaWxkLmNodW5rU2l6ZSgpO1xuICAgICAgICBpZiAobiA8IHN6KSB7IGNodW5rID0gY2hpbGQ7IGJyZWFrOyB9XG4gICAgICAgIG4gLT0gc3o7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBjaHVuay5saW5lc1tuXTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGdldEJldHdlZW4oZG9jLCBzdGFydCwgZW5kKSB7XG4gICAgdmFyIG91dCA9IFtdLCBuID0gc3RhcnQubGluZTtcbiAgICBkb2MuaXRlcihzdGFydC5saW5lLCBlbmQubGluZSArIDEsIGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgIHZhciB0ZXh0ID0gbGluZS50ZXh0O1xuICAgICAgaWYgKG4gPT0gZW5kLmxpbmUpIHRleHQgPSB0ZXh0LnNsaWNlKDAsIGVuZC5jaCk7XG4gICAgICBpZiAobiA9PSBzdGFydC5saW5lKSB0ZXh0ID0gdGV4dC5zbGljZShzdGFydC5jaCk7XG4gICAgICBvdXQucHVzaCh0ZXh0KTtcbiAgICAgICsrbjtcbiAgICB9KTtcbiAgICByZXR1cm4gb3V0O1xuICB9XG4gIGZ1bmN0aW9uIGdldExpbmVzKGRvYywgZnJvbSwgdG8pIHtcbiAgICB2YXIgb3V0ID0gW107XG4gICAgZG9jLml0ZXIoZnJvbSwgdG8sIGZ1bmN0aW9uKGxpbmUpIHsgb3V0LnB1c2gobGluZS50ZXh0KTsgfSk7XG4gICAgcmV0dXJuIG91dDtcbiAgfVxuXG4gIGZ1bmN0aW9uIHVwZGF0ZUxpbmVIZWlnaHQobGluZSwgaGVpZ2h0KSB7XG4gICAgdmFyIGRpZmYgPSBoZWlnaHQgLSBsaW5lLmhlaWdodDtcbiAgICBmb3IgKHZhciBuID0gbGluZTsgbjsgbiA9IG4ucGFyZW50KSBuLmhlaWdodCArPSBkaWZmO1xuICB9XG5cbiAgZnVuY3Rpb24gbGluZU5vKGxpbmUpIHtcbiAgICBpZiAobGluZS5wYXJlbnQgPT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gICAgdmFyIGN1ciA9IGxpbmUucGFyZW50LCBubyA9IGluZGV4T2YoY3VyLmxpbmVzLCBsaW5lKTtcbiAgICBmb3IgKHZhciBjaHVuayA9IGN1ci5wYXJlbnQ7IGNodW5rOyBjdXIgPSBjaHVuaywgY2h1bmsgPSBjaHVuay5wYXJlbnQpIHtcbiAgICAgIGZvciAodmFyIGkgPSAwOzsgKytpKSB7XG4gICAgICAgIGlmIChjaHVuay5jaGlsZHJlbltpXSA9PSBjdXIpIGJyZWFrO1xuICAgICAgICBubyArPSBjaHVuay5jaGlsZHJlbltpXS5jaHVua1NpemUoKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIG5vICsgY3VyLmZpcnN0O1xuICB9XG5cbiAgZnVuY3Rpb24gbGluZUF0SGVpZ2h0KGNodW5rLCBoKSB7XG4gICAgdmFyIG4gPSBjaHVuay5maXJzdDtcbiAgICBvdXRlcjogZG8ge1xuICAgICAgZm9yICh2YXIgaSA9IDAsIGUgPSBjaHVuay5jaGlsZHJlbi5sZW5ndGg7IGkgPCBlOyArK2kpIHtcbiAgICAgICAgdmFyIGNoaWxkID0gY2h1bmsuY2hpbGRyZW5baV0sIGNoID0gY2hpbGQuaGVpZ2h0O1xuICAgICAgICBpZiAoaCA8IGNoKSB7IGNodW5rID0gY2hpbGQ7IGNvbnRpbnVlIG91dGVyOyB9XG4gICAgICAgIGggLT0gY2g7XG4gICAgICAgIG4gKz0gY2hpbGQuY2h1bmtTaXplKCk7XG4gICAgICB9XG4gICAgICByZXR1cm4gbjtcbiAgICB9IHdoaWxlICghY2h1bmsubGluZXMpO1xuICAgIGZvciAodmFyIGkgPSAwLCBlID0gY2h1bmsubGluZXMubGVuZ3RoOyBpIDwgZTsgKytpKSB7XG4gICAgICB2YXIgbGluZSA9IGNodW5rLmxpbmVzW2ldLCBsaCA9IGxpbmUuaGVpZ2h0O1xuICAgICAgaWYgKGggPCBsaCkgYnJlYWs7XG4gICAgICBoIC09IGxoO1xuICAgIH1cbiAgICByZXR1cm4gbiArIGk7XG4gIH1cblxuICBmdW5jdGlvbiBoZWlnaHRBdExpbmUoY20sIGxpbmVPYmopIHtcbiAgICBsaW5lT2JqID0gdmlzdWFsTGluZShjbS5kb2MsIGxpbmVPYmopO1xuXG4gICAgdmFyIGggPSAwLCBjaHVuayA9IGxpbmVPYmoucGFyZW50O1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgY2h1bmsubGluZXMubGVuZ3RoOyArK2kpIHtcbiAgICAgIHZhciBsaW5lID0gY2h1bmsubGluZXNbaV07XG4gICAgICBpZiAobGluZSA9PSBsaW5lT2JqKSBicmVhaztcbiAgICAgIGVsc2UgaCArPSBsaW5lLmhlaWdodDtcbiAgICB9XG4gICAgZm9yICh2YXIgcCA9IGNodW5rLnBhcmVudDsgcDsgY2h1bmsgPSBwLCBwID0gY2h1bmsucGFyZW50KSB7XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHAuY2hpbGRyZW4ubGVuZ3RoOyArK2kpIHtcbiAgICAgICAgdmFyIGN1ciA9IHAuY2hpbGRyZW5baV07XG4gICAgICAgIGlmIChjdXIgPT0gY2h1bmspIGJyZWFrO1xuICAgICAgICBlbHNlIGggKz0gY3VyLmhlaWdodDtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGg7XG4gIH1cblxuICBmdW5jdGlvbiBnZXRPcmRlcihsaW5lKSB7XG4gICAgdmFyIG9yZGVyID0gbGluZS5vcmRlcjtcbiAgICBpZiAob3JkZXIgPT0gbnVsbCkgb3JkZXIgPSBsaW5lLm9yZGVyID0gYmlkaU9yZGVyaW5nKGxpbmUudGV4dCk7XG4gICAgcmV0dXJuIG9yZGVyO1xuICB9XG5cbiAgLy8gSElTVE9SWVxuXG4gIGZ1bmN0aW9uIG1ha2VIaXN0b3J5KHN0YXJ0R2VuKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIC8vIEFycmF5cyBvZiBoaXN0b3J5IGV2ZW50cy4gRG9pbmcgc29tZXRoaW5nIGFkZHMgYW4gZXZlbnQgdG9cbiAgICAgIC8vIGRvbmUgYW5kIGNsZWFycyB1bmRvLiBVbmRvaW5nIG1vdmVzIGV2ZW50cyBmcm9tIGRvbmUgdG9cbiAgICAgIC8vIHVuZG9uZSwgcmVkb2luZyBtb3ZlcyB0aGVtIGluIHRoZSBvdGhlciBkaXJlY3Rpb24uXG4gICAgICBkb25lOiBbXSwgdW5kb25lOiBbXSwgdW5kb0RlcHRoOiBJbmZpbml0eSxcbiAgICAgIC8vIFVzZWQgdG8gdHJhY2sgd2hlbiBjaGFuZ2VzIGNhbiBiZSBtZXJnZWQgaW50byBhIHNpbmdsZSB1bmRvXG4gICAgICAvLyBldmVudFxuICAgICAgbGFzdFRpbWU6IDAsIGxhc3RPcDogbnVsbCwgbGFzdE9yaWdpbjogbnVsbCxcbiAgICAgIC8vIFVzZWQgYnkgdGhlIGlzQ2xlYW4oKSBtZXRob2RcbiAgICAgIGdlbmVyYXRpb246IHN0YXJ0R2VuIHx8IDEsIG1heEdlbmVyYXRpb246IHN0YXJ0R2VuIHx8IDFcbiAgICB9O1xuICB9XG5cbiAgZnVuY3Rpb24gYXR0YWNoTG9jYWxTcGFucyhkb2MsIGNoYW5nZSwgZnJvbSwgdG8pIHtcbiAgICB2YXIgZXhpc3RpbmcgPSBjaGFuZ2VbXCJzcGFuc19cIiArIGRvYy5pZF0sIG4gPSAwO1xuICAgIGRvYy5pdGVyKE1hdGgubWF4KGRvYy5maXJzdCwgZnJvbSksIE1hdGgubWluKGRvYy5maXJzdCArIGRvYy5zaXplLCB0byksIGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgIGlmIChsaW5lLm1hcmtlZFNwYW5zKVxuICAgICAgICAoZXhpc3RpbmcgfHwgKGV4aXN0aW5nID0gY2hhbmdlW1wic3BhbnNfXCIgKyBkb2MuaWRdID0ge30pKVtuXSA9IGxpbmUubWFya2VkU3BhbnM7XG4gICAgICArK247XG4gICAgfSk7XG4gIH1cblxuICBmdW5jdGlvbiBoaXN0b3J5Q2hhbmdlRnJvbUNoYW5nZShkb2MsIGNoYW5nZSkge1xuICAgIHZhciBmcm9tID0geyBsaW5lOiBjaGFuZ2UuZnJvbS5saW5lLCBjaDogY2hhbmdlLmZyb20uY2ggfTtcbiAgICB2YXIgaGlzdENoYW5nZSA9IHtmcm9tOiBmcm9tLCB0bzogY2hhbmdlRW5kKGNoYW5nZSksIHRleHQ6IGdldEJldHdlZW4oZG9jLCBjaGFuZ2UuZnJvbSwgY2hhbmdlLnRvKX07XG4gICAgYXR0YWNoTG9jYWxTcGFucyhkb2MsIGhpc3RDaGFuZ2UsIGNoYW5nZS5mcm9tLmxpbmUsIGNoYW5nZS50by5saW5lICsgMSk7XG4gICAgbGlua2VkRG9jcyhkb2MsIGZ1bmN0aW9uKGRvYykge2F0dGFjaExvY2FsU3BhbnMoZG9jLCBoaXN0Q2hhbmdlLCBjaGFuZ2UuZnJvbS5saW5lLCBjaGFuZ2UudG8ubGluZSArIDEpO30sIHRydWUpO1xuICAgIHJldHVybiBoaXN0Q2hhbmdlO1xuICB9XG5cbiAgZnVuY3Rpb24gYWRkVG9IaXN0b3J5KGRvYywgY2hhbmdlLCBzZWxBZnRlciwgb3BJZCkge1xuICAgIHZhciBoaXN0ID0gZG9jLmhpc3Rvcnk7XG4gICAgaGlzdC51bmRvbmUubGVuZ3RoID0gMDtcbiAgICB2YXIgdGltZSA9ICtuZXcgRGF0ZSwgY3VyID0gbHN0KGhpc3QuZG9uZSk7XG5cbiAgICBpZiAoY3VyICYmXG4gICAgICAgIChoaXN0Lmxhc3RPcCA9PSBvcElkIHx8XG4gICAgICAgICBoaXN0Lmxhc3RPcmlnaW4gPT0gY2hhbmdlLm9yaWdpbiAmJiBjaGFuZ2Uub3JpZ2luICYmXG4gICAgICAgICAoKGNoYW5nZS5vcmlnaW4uY2hhckF0KDApID09IFwiK1wiICYmIGRvYy5jbSAmJiBoaXN0Lmxhc3RUaW1lID4gdGltZSAtIGRvYy5jbS5vcHRpb25zLmhpc3RvcnlFdmVudERlbGF5KSB8fFxuICAgICAgICAgIGNoYW5nZS5vcmlnaW4uY2hhckF0KDApID09IFwiKlwiKSkpIHtcbiAgICAgIC8vIE1lcmdlIHRoaXMgY2hhbmdlIGludG8gdGhlIGxhc3QgZXZlbnRcbiAgICAgIHZhciBsYXN0ID0gbHN0KGN1ci5jaGFuZ2VzKTtcbiAgICAgIGlmIChwb3NFcShjaGFuZ2UuZnJvbSwgY2hhbmdlLnRvKSAmJiBwb3NFcShjaGFuZ2UuZnJvbSwgbGFzdC50bykpIHtcbiAgICAgICAgLy8gT3B0aW1pemVkIGNhc2UgZm9yIHNpbXBsZSBpbnNlcnRpb24gLS0gZG9uJ3Qgd2FudCB0byBhZGRcbiAgICAgICAgLy8gbmV3IGNoYW5nZXNldHMgZm9yIGV2ZXJ5IGNoYXJhY3RlciB0eXBlZFxuICAgICAgICBsYXN0LnRvID0gY2hhbmdlRW5kKGNoYW5nZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBBZGQgbmV3IHN1Yi1ldmVudFxuICAgICAgICBjdXIuY2hhbmdlcy5wdXNoKGhpc3RvcnlDaGFuZ2VGcm9tQ2hhbmdlKGRvYywgY2hhbmdlKSk7XG4gICAgICB9XG4gICAgICBjdXIuYW5jaG9yQWZ0ZXIgPSBzZWxBZnRlci5hbmNob3I7IGN1ci5oZWFkQWZ0ZXIgPSBzZWxBZnRlci5oZWFkO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBDYW4gbm90IGJlIG1lcmdlZCwgc3RhcnQgYSBuZXcgZXZlbnQuXG4gICAgICBjdXIgPSB7Y2hhbmdlczogW2hpc3RvcnlDaGFuZ2VGcm9tQ2hhbmdlKGRvYywgY2hhbmdlKV0sXG4gICAgICAgICAgICAgZ2VuZXJhdGlvbjogaGlzdC5nZW5lcmF0aW9uLFxuICAgICAgICAgICAgIGFuY2hvckJlZm9yZTogZG9jLnNlbC5hbmNob3IsIGhlYWRCZWZvcmU6IGRvYy5zZWwuaGVhZCxcbiAgICAgICAgICAgICBhbmNob3JBZnRlcjogc2VsQWZ0ZXIuYW5jaG9yLCBoZWFkQWZ0ZXI6IHNlbEFmdGVyLmhlYWR9O1xuICAgICAgaGlzdC5kb25lLnB1c2goY3VyKTtcbiAgICAgIHdoaWxlIChoaXN0LmRvbmUubGVuZ3RoID4gaGlzdC51bmRvRGVwdGgpXG4gICAgICAgIGhpc3QuZG9uZS5zaGlmdCgpO1xuICAgIH1cbiAgICBoaXN0LmdlbmVyYXRpb24gPSArK2hpc3QubWF4R2VuZXJhdGlvbjtcbiAgICBoaXN0Lmxhc3RUaW1lID0gdGltZTtcbiAgICBoaXN0Lmxhc3RPcCA9IG9wSWQ7XG4gICAgaGlzdC5sYXN0T3JpZ2luID0gY2hhbmdlLm9yaWdpbjtcblxuICAgIGlmICghbGFzdCkgc2lnbmFsKGRvYywgXCJoaXN0b3J5QWRkZWRcIik7XG4gIH1cblxuICBmdW5jdGlvbiByZW1vdmVDbGVhcmVkU3BhbnMoc3BhbnMpIHtcbiAgICBpZiAoIXNwYW5zKSByZXR1cm4gbnVsbDtcbiAgICBmb3IgKHZhciBpID0gMCwgb3V0OyBpIDwgc3BhbnMubGVuZ3RoOyArK2kpIHtcbiAgICAgIGlmIChzcGFuc1tpXS5tYXJrZXIuZXhwbGljaXRseUNsZWFyZWQpIHsgaWYgKCFvdXQpIG91dCA9IHNwYW5zLnNsaWNlKDAsIGkpOyB9XG4gICAgICBlbHNlIGlmIChvdXQpIG91dC5wdXNoKHNwYW5zW2ldKTtcbiAgICB9XG4gICAgcmV0dXJuICFvdXQgPyBzcGFucyA6IG91dC5sZW5ndGggPyBvdXQgOiBudWxsO1xuICB9XG5cbiAgZnVuY3Rpb24gZ2V0T2xkU3BhbnMoZG9jLCBjaGFuZ2UpIHtcbiAgICB2YXIgZm91bmQgPSBjaGFuZ2VbXCJzcGFuc19cIiArIGRvYy5pZF07XG4gICAgaWYgKCFmb3VuZCkgcmV0dXJuIG51bGw7XG4gICAgZm9yICh2YXIgaSA9IDAsIG53ID0gW107IGkgPCBjaGFuZ2UudGV4dC5sZW5ndGg7ICsraSlcbiAgICAgIG53LnB1c2gocmVtb3ZlQ2xlYXJlZFNwYW5zKGZvdW5kW2ldKSk7XG4gICAgcmV0dXJuIG53O1xuICB9XG5cbiAgLy8gVXNlZCBib3RoIHRvIHByb3ZpZGUgYSBKU09OLXNhZmUgb2JqZWN0IGluIC5nZXRIaXN0b3J5LCBhbmQsIHdoZW5cbiAgLy8gZGV0YWNoaW5nIGEgZG9jdW1lbnQsIHRvIHNwbGl0IHRoZSBoaXN0b3J5IGluIHR3b1xuICBmdW5jdGlvbiBjb3B5SGlzdG9yeUFycmF5KGV2ZW50cywgbmV3R3JvdXApIHtcbiAgICBmb3IgKHZhciBpID0gMCwgY29weSA9IFtdOyBpIDwgZXZlbnRzLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YXIgZXZlbnQgPSBldmVudHNbaV0sIGNoYW5nZXMgPSBldmVudC5jaGFuZ2VzLCBuZXdDaGFuZ2VzID0gW107XG4gICAgICBjb3B5LnB1c2goe2NoYW5nZXM6IG5ld0NoYW5nZXMsIGFuY2hvckJlZm9yZTogZXZlbnQuYW5jaG9yQmVmb3JlLCBoZWFkQmVmb3JlOiBldmVudC5oZWFkQmVmb3JlLFxuICAgICAgICAgICAgICAgICBhbmNob3JBZnRlcjogZXZlbnQuYW5jaG9yQWZ0ZXIsIGhlYWRBZnRlcjogZXZlbnQuaGVhZEFmdGVyfSk7XG4gICAgICBmb3IgKHZhciBqID0gMDsgaiA8IGNoYW5nZXMubGVuZ3RoOyArK2opIHtcbiAgICAgICAgdmFyIGNoYW5nZSA9IGNoYW5nZXNbal0sIG07XG4gICAgICAgIG5ld0NoYW5nZXMucHVzaCh7ZnJvbTogY2hhbmdlLmZyb20sIHRvOiBjaGFuZ2UudG8sIHRleHQ6IGNoYW5nZS50ZXh0fSk7XG4gICAgICAgIGlmIChuZXdHcm91cCkgZm9yICh2YXIgcHJvcCBpbiBjaGFuZ2UpIGlmIChtID0gcHJvcC5tYXRjaCgvXnNwYW5zXyhcXGQrKSQvKSkge1xuICAgICAgICAgIGlmIChpbmRleE9mKG5ld0dyb3VwLCBOdW1iZXIobVsxXSkpID4gLTEpIHtcbiAgICAgICAgICAgIGxzdChuZXdDaGFuZ2VzKVtwcm9wXSA9IGNoYW5nZVtwcm9wXTtcbiAgICAgICAgICAgIGRlbGV0ZSBjaGFuZ2VbcHJvcF07XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBjb3B5O1xuICB9XG5cbiAgLy8gUmViYXNpbmcvcmVzZXR0aW5nIGhpc3RvcnkgdG8gZGVhbCB3aXRoIGV4dGVybmFsbHktc291cmNlZCBjaGFuZ2VzXG5cbiAgZnVuY3Rpb24gcmViYXNlSGlzdFNlbChwb3MsIGZyb20sIHRvLCBkaWZmKSB7XG4gICAgaWYgKHRvIDwgcG9zLmxpbmUpIHtcbiAgICAgIHBvcy5saW5lICs9IGRpZmY7XG4gICAgfSBlbHNlIGlmIChmcm9tIDwgcG9zLmxpbmUpIHtcbiAgICAgIHBvcy5saW5lID0gZnJvbTtcbiAgICAgIHBvcy5jaCA9IDA7XG4gICAgfVxuICB9XG5cbiAgLy8gVHJpZXMgdG8gcmViYXNlIGFuIGFycmF5IG9mIGhpc3RvcnkgZXZlbnRzIGdpdmVuIGEgY2hhbmdlIGluIHRoZVxuICAvLyBkb2N1bWVudC4gSWYgdGhlIGNoYW5nZSB0b3VjaGVzIHRoZSBzYW1lIGxpbmVzIGFzIHRoZSBldmVudCwgdGhlXG4gIC8vIGV2ZW50LCBhbmQgZXZlcnl0aGluZyAnYmVoaW5kJyBpdCwgaXMgZGlzY2FyZGVkLiBJZiB0aGUgY2hhbmdlIGlzXG4gIC8vIGJlZm9yZSB0aGUgZXZlbnQsIHRoZSBldmVudCdzIHBvc2l0aW9ucyBhcmUgdXBkYXRlZC4gVXNlcyBhXG4gIC8vIGNvcHktb24td3JpdGUgc2NoZW1lIGZvciB0aGUgcG9zaXRpb25zLCB0byBhdm9pZCBoYXZpbmcgdG9cbiAgLy8gcmVhbGxvY2F0ZSB0aGVtIGFsbCBvbiBldmVyeSByZWJhc2UsIGJ1dCBhbHNvIGF2b2lkIHByb2JsZW1zIHdpdGhcbiAgLy8gc2hhcmVkIHBvc2l0aW9uIG9iamVjdHMgYmVpbmcgdW5zYWZlbHkgdXBkYXRlZC5cbiAgZnVuY3Rpb24gcmViYXNlSGlzdEFycmF5KGFycmF5LCBmcm9tLCB0bywgZGlmZikge1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYXJyYXkubGVuZ3RoOyArK2kpIHtcbiAgICAgIHZhciBzdWIgPSBhcnJheVtpXSwgb2sgPSB0cnVlO1xuICAgICAgZm9yICh2YXIgaiA9IDA7IGogPCBzdWIuY2hhbmdlcy5sZW5ndGg7ICsraikge1xuICAgICAgICB2YXIgY3VyID0gc3ViLmNoYW5nZXNbal07XG4gICAgICAgIGlmICghc3ViLmNvcGllZCkgeyBjdXIuZnJvbSA9IGNvcHlQb3MoY3VyLmZyb20pOyBjdXIudG8gPSBjb3B5UG9zKGN1ci50byk7IH1cbiAgICAgICAgaWYgKHRvIDwgY3VyLmZyb20ubGluZSkge1xuICAgICAgICAgIGN1ci5mcm9tLmxpbmUgKz0gZGlmZjtcbiAgICAgICAgICBjdXIudG8ubGluZSArPSBkaWZmO1xuICAgICAgICB9IGVsc2UgaWYgKGZyb20gPD0gY3VyLnRvLmxpbmUpIHtcbiAgICAgICAgICBvayA9IGZhbHNlO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoIXN1Yi5jb3BpZWQpIHtcbiAgICAgICAgc3ViLmFuY2hvckJlZm9yZSA9IGNvcHlQb3Moc3ViLmFuY2hvckJlZm9yZSk7IHN1Yi5oZWFkQmVmb3JlID0gY29weVBvcyhzdWIuaGVhZEJlZm9yZSk7XG4gICAgICAgIHN1Yi5hbmNob3JBZnRlciA9IGNvcHlQb3Moc3ViLmFuY2hvckFmdGVyKTsgc3ViLnJlYWRBZnRlciA9IGNvcHlQb3Moc3ViLmhlYWRBZnRlcik7XG4gICAgICAgIHN1Yi5jb3BpZWQgPSB0cnVlO1xuICAgICAgfVxuICAgICAgaWYgKCFvaykge1xuICAgICAgICBhcnJheS5zcGxpY2UoMCwgaSArIDEpO1xuICAgICAgICBpID0gMDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlYmFzZUhpc3RTZWwoc3ViLmFuY2hvckJlZm9yZSk7IHJlYmFzZUhpc3RTZWwoc3ViLmhlYWRCZWZvcmUpO1xuICAgICAgICByZWJhc2VIaXN0U2VsKHN1Yi5hbmNob3JBZnRlcik7IHJlYmFzZUhpc3RTZWwoc3ViLmhlYWRBZnRlcik7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gcmViYXNlSGlzdChoaXN0LCBjaGFuZ2UpIHtcbiAgICB2YXIgZnJvbSA9IGNoYW5nZS5mcm9tLmxpbmUsIHRvID0gY2hhbmdlLnRvLmxpbmUsIGRpZmYgPSBjaGFuZ2UudGV4dC5sZW5ndGggLSAodG8gLSBmcm9tKSAtIDE7XG4gICAgcmViYXNlSGlzdEFycmF5KGhpc3QuZG9uZSwgZnJvbSwgdG8sIGRpZmYpO1xuICAgIHJlYmFzZUhpc3RBcnJheShoaXN0LnVuZG9uZSwgZnJvbSwgdG8sIGRpZmYpO1xuICB9XG5cbiAgLy8gRVZFTlQgT1BFUkFUT1JTXG5cbiAgZnVuY3Rpb24gc3RvcE1ldGhvZCgpIHtlX3N0b3AodGhpcyk7fVxuICAvLyBFbnN1cmUgYW4gZXZlbnQgaGFzIGEgc3RvcCBtZXRob2QuXG4gIGZ1bmN0aW9uIGFkZFN0b3AoZXZlbnQpIHtcbiAgICBpZiAoIWV2ZW50LnN0b3ApIGV2ZW50LnN0b3AgPSBzdG9wTWV0aG9kO1xuICAgIHJldHVybiBldmVudDtcbiAgfVxuXG4gIGZ1bmN0aW9uIGVfcHJldmVudERlZmF1bHQoZSkge1xuICAgIGlmIChlLnByZXZlbnREZWZhdWx0KSBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZWxzZSBlLnJldHVyblZhbHVlID0gZmFsc2U7XG4gIH1cbiAgZnVuY3Rpb24gZV9zdG9wUHJvcGFnYXRpb24oZSkge1xuICAgIGlmIChlLnN0b3BQcm9wYWdhdGlvbikgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBlbHNlIGUuY2FuY2VsQnViYmxlID0gdHJ1ZTtcbiAgfVxuICBmdW5jdGlvbiBlX2RlZmF1bHRQcmV2ZW50ZWQoZSkge1xuICAgIHJldHVybiBlLmRlZmF1bHRQcmV2ZW50ZWQgIT0gbnVsbCA/IGUuZGVmYXVsdFByZXZlbnRlZCA6IGUucmV0dXJuVmFsdWUgPT0gZmFsc2U7XG4gIH1cbiAgZnVuY3Rpb24gZV9zdG9wKGUpIHtlX3ByZXZlbnREZWZhdWx0KGUpOyBlX3N0b3BQcm9wYWdhdGlvbihlKTt9XG4gIENvZGVNaXJyb3IuZV9zdG9wID0gZV9zdG9wO1xuICBDb2RlTWlycm9yLmVfcHJldmVudERlZmF1bHQgPSBlX3ByZXZlbnREZWZhdWx0O1xuICBDb2RlTWlycm9yLmVfc3RvcFByb3BhZ2F0aW9uID0gZV9zdG9wUHJvcGFnYXRpb247XG5cbiAgZnVuY3Rpb24gZV90YXJnZXQoZSkge3JldHVybiBlLnRhcmdldCB8fCBlLnNyY0VsZW1lbnQ7fVxuICBmdW5jdGlvbiBlX2J1dHRvbihlKSB7XG4gICAgdmFyIGIgPSBlLndoaWNoO1xuICAgIGlmIChiID09IG51bGwpIHtcbiAgICAgIGlmIChlLmJ1dHRvbiAmIDEpIGIgPSAxO1xuICAgICAgZWxzZSBpZiAoZS5idXR0b24gJiAyKSBiID0gMztcbiAgICAgIGVsc2UgaWYgKGUuYnV0dG9uICYgNCkgYiA9IDI7XG4gICAgfVxuICAgIGlmIChtYWMgJiYgZS5jdHJsS2V5ICYmIGIgPT0gMSkgYiA9IDM7XG4gICAgcmV0dXJuIGI7XG4gIH1cblxuICAvLyBFVkVOVCBIQU5ETElOR1xuXG4gIGZ1bmN0aW9uIG9uKGVtaXR0ZXIsIHR5cGUsIGYpIHtcbiAgICBpZiAoZW1pdHRlci5hZGRFdmVudExpc3RlbmVyKVxuICAgICAgZW1pdHRlci5hZGRFdmVudExpc3RlbmVyKHR5cGUsIGYsIGZhbHNlKTtcbiAgICBlbHNlIGlmIChlbWl0dGVyLmF0dGFjaEV2ZW50KVxuICAgICAgZW1pdHRlci5hdHRhY2hFdmVudChcIm9uXCIgKyB0eXBlLCBmKTtcbiAgICBlbHNlIHtcbiAgICAgIHZhciBtYXAgPSBlbWl0dGVyLl9oYW5kbGVycyB8fCAoZW1pdHRlci5faGFuZGxlcnMgPSB7fSk7XG4gICAgICB2YXIgYXJyID0gbWFwW3R5cGVdIHx8IChtYXBbdHlwZV0gPSBbXSk7XG4gICAgICBhcnIucHVzaChmKTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBvZmYoZW1pdHRlciwgdHlwZSwgZikge1xuICAgIGlmIChlbWl0dGVyLnJlbW92ZUV2ZW50TGlzdGVuZXIpXG4gICAgICBlbWl0dGVyLnJlbW92ZUV2ZW50TGlzdGVuZXIodHlwZSwgZiwgZmFsc2UpO1xuICAgIGVsc2UgaWYgKGVtaXR0ZXIuZGV0YWNoRXZlbnQpXG4gICAgICBlbWl0dGVyLmRldGFjaEV2ZW50KFwib25cIiArIHR5cGUsIGYpO1xuICAgIGVsc2Uge1xuICAgICAgdmFyIGFyciA9IGVtaXR0ZXIuX2hhbmRsZXJzICYmIGVtaXR0ZXIuX2hhbmRsZXJzW3R5cGVdO1xuICAgICAgaWYgKCFhcnIpIHJldHVybjtcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYXJyLmxlbmd0aDsgKytpKVxuICAgICAgICBpZiAoYXJyW2ldID09IGYpIHsgYXJyLnNwbGljZShpLCAxKTsgYnJlYWs7IH1cbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBzaWduYWwoZW1pdHRlciwgdHlwZSAvKiwgdmFsdWVzLi4uKi8pIHtcbiAgICB2YXIgYXJyID0gZW1pdHRlci5faGFuZGxlcnMgJiYgZW1pdHRlci5faGFuZGxlcnNbdHlwZV07XG4gICAgaWYgKCFhcnIpIHJldHVybjtcbiAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMik7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBhcnIubGVuZ3RoOyArK2kpIGFycltpXS5hcHBseShudWxsLCBhcmdzKTtcbiAgfVxuXG4gIHZhciBkZWxheWVkQ2FsbGJhY2tzLCBkZWxheWVkQ2FsbGJhY2tEZXB0aCA9IDA7XG4gIGZ1bmN0aW9uIHNpZ25hbExhdGVyKGVtaXR0ZXIsIHR5cGUgLyosIHZhbHVlcy4uLiovKSB7XG4gICAgdmFyIGFyciA9IGVtaXR0ZXIuX2hhbmRsZXJzICYmIGVtaXR0ZXIuX2hhbmRsZXJzW3R5cGVdO1xuICAgIGlmICghYXJyKSByZXR1cm47XG4gICAgdmFyIGFyZ3MgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMsIDIpO1xuICAgIGlmICghZGVsYXllZENhbGxiYWNrcykge1xuICAgICAgKytkZWxheWVkQ2FsbGJhY2tEZXB0aDtcbiAgICAgIGRlbGF5ZWRDYWxsYmFja3MgPSBbXTtcbiAgICAgIHNldFRpbWVvdXQoZmlyZURlbGF5ZWQsIDApO1xuICAgIH1cbiAgICBmdW5jdGlvbiBibmQoZikge3JldHVybiBmdW5jdGlvbigpe2YuYXBwbHkobnVsbCwgYXJncyk7fTt9O1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYXJyLmxlbmd0aDsgKytpKVxuICAgICAgZGVsYXllZENhbGxiYWNrcy5wdXNoKGJuZChhcnJbaV0pKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHNpZ25hbERPTUV2ZW50KGNtLCBlLCBvdmVycmlkZSkge1xuICAgIHNpZ25hbChjbSwgb3ZlcnJpZGUgfHwgZS50eXBlLCBjbSwgZSk7XG4gICAgcmV0dXJuIGVfZGVmYXVsdFByZXZlbnRlZChlKSB8fCBlLmNvZGVtaXJyb3JJZ25vcmU7XG4gIH1cblxuICBmdW5jdGlvbiBmaXJlRGVsYXllZCgpIHtcbiAgICAtLWRlbGF5ZWRDYWxsYmFja0RlcHRoO1xuICAgIHZhciBkZWxheWVkID0gZGVsYXllZENhbGxiYWNrcztcbiAgICBkZWxheWVkQ2FsbGJhY2tzID0gbnVsbDtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGRlbGF5ZWQubGVuZ3RoOyArK2kpIGRlbGF5ZWRbaV0oKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhhc0hhbmRsZXIoZW1pdHRlciwgdHlwZSkge1xuICAgIHZhciBhcnIgPSBlbWl0dGVyLl9oYW5kbGVycyAmJiBlbWl0dGVyLl9oYW5kbGVyc1t0eXBlXTtcbiAgICByZXR1cm4gYXJyICYmIGFyci5sZW5ndGggPiAwO1xuICB9XG5cbiAgQ29kZU1pcnJvci5vbiA9IG9uOyBDb2RlTWlycm9yLm9mZiA9IG9mZjsgQ29kZU1pcnJvci5zaWduYWwgPSBzaWduYWw7XG5cbiAgZnVuY3Rpb24gZXZlbnRNaXhpbihjdG9yKSB7XG4gICAgY3Rvci5wcm90b3R5cGUub24gPSBmdW5jdGlvbih0eXBlLCBmKSB7b24odGhpcywgdHlwZSwgZik7fTtcbiAgICBjdG9yLnByb3RvdHlwZS5vZmYgPSBmdW5jdGlvbih0eXBlLCBmKSB7b2ZmKHRoaXMsIHR5cGUsIGYpO307XG4gIH1cblxuICAvLyBNSVNDIFVUSUxJVElFU1xuXG4gIC8vIE51bWJlciBvZiBwaXhlbHMgYWRkZWQgdG8gc2Nyb2xsZXIgYW5kIHNpemVyIHRvIGhpZGUgc2Nyb2xsYmFyXG4gIHZhciBzY3JvbGxlckN1dE9mZiA9IDMwO1xuXG4gIC8vIFJldHVybmVkIG9yIHRocm93biBieSB2YXJpb3VzIHByb3RvY29scyB0byBzaWduYWwgJ0knbSBub3RcbiAgLy8gaGFuZGxpbmcgdGhpcycuXG4gIHZhciBQYXNzID0gQ29kZU1pcnJvci5QYXNzID0ge3RvU3RyaW5nOiBmdW5jdGlvbigpe3JldHVybiBcIkNvZGVNaXJyb3IuUGFzc1wiO319O1xuXG4gIGZ1bmN0aW9uIERlbGF5ZWQoKSB7dGhpcy5pZCA9IG51bGw7fVxuICBEZWxheWVkLnByb3RvdHlwZSA9IHtzZXQ6IGZ1bmN0aW9uKG1zLCBmKSB7Y2xlYXJUaW1lb3V0KHRoaXMuaWQpOyB0aGlzLmlkID0gc2V0VGltZW91dChmLCBtcyk7fX07XG5cbiAgLy8gQ291bnRzIHRoZSBjb2x1bW4gb2Zmc2V0IGluIGEgc3RyaW5nLCB0YWtpbmcgdGFicyBpbnRvIGFjY291bnQuXG4gIC8vIFVzZWQgbW9zdGx5IHRvIGZpbmQgaW5kZW50YXRpb24uXG4gIGZ1bmN0aW9uIGNvdW50Q29sdW1uKHN0cmluZywgZW5kLCB0YWJTaXplLCBzdGFydEluZGV4LCBzdGFydFZhbHVlKSB7XG4gICAgaWYgKGVuZCA9PSBudWxsKSB7XG4gICAgICBlbmQgPSBzdHJpbmcuc2VhcmNoKC9bXlxcc1xcdTAwYTBdLyk7XG4gICAgICBpZiAoZW5kID09IC0xKSBlbmQgPSBzdHJpbmcubGVuZ3RoO1xuICAgIH1cbiAgICBmb3IgKHZhciBpID0gc3RhcnRJbmRleCB8fCAwLCBuID0gc3RhcnRWYWx1ZSB8fCAwOyBpIDwgZW5kOyArK2kpIHtcbiAgICAgIGlmIChzdHJpbmcuY2hhckF0KGkpID09IFwiXFx0XCIpIG4gKz0gdGFiU2l6ZSAtIChuICUgdGFiU2l6ZSk7XG4gICAgICBlbHNlICsrbjtcbiAgICB9XG4gICAgcmV0dXJuIG47XG4gIH1cbiAgQ29kZU1pcnJvci5jb3VudENvbHVtbiA9IGNvdW50Q29sdW1uO1xuXG4gIHZhciBzcGFjZVN0cnMgPSBbXCJcIl07XG4gIGZ1bmN0aW9uIHNwYWNlU3RyKG4pIHtcbiAgICB3aGlsZSAoc3BhY2VTdHJzLmxlbmd0aCA8PSBuKVxuICAgICAgc3BhY2VTdHJzLnB1c2gobHN0KHNwYWNlU3RycykgKyBcIiBcIik7XG4gICAgcmV0dXJuIHNwYWNlU3Ryc1tuXTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGxzdChhcnIpIHsgcmV0dXJuIGFyclthcnIubGVuZ3RoLTFdOyB9XG5cbiAgZnVuY3Rpb24gc2VsZWN0SW5wdXQobm9kZSkge1xuICAgIGlmIChpb3MpIHsgLy8gTW9iaWxlIFNhZmFyaSBhcHBhcmVudGx5IGhhcyBhIGJ1ZyB3aGVyZSBzZWxlY3QoKSBpcyBicm9rZW4uXG4gICAgICBub2RlLnNlbGVjdGlvblN0YXJ0ID0gMDtcbiAgICAgIG5vZGUuc2VsZWN0aW9uRW5kID0gbm9kZS52YWx1ZS5sZW5ndGg7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIFN1cHByZXNzIG15c3RlcmlvdXMgSUUxMCBlcnJvcnNcbiAgICAgIHRyeSB7IG5vZGUuc2VsZWN0KCk7IH1cbiAgICAgIGNhdGNoKF9lKSB7fVxuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGluZGV4T2YoY29sbGVjdGlvbiwgZWx0KSB7XG4gICAgaWYgKGNvbGxlY3Rpb24uaW5kZXhPZikgcmV0dXJuIGNvbGxlY3Rpb24uaW5kZXhPZihlbHQpO1xuICAgIGZvciAodmFyIGkgPSAwLCBlID0gY29sbGVjdGlvbi5sZW5ndGg7IGkgPCBlOyArK2kpXG4gICAgICBpZiAoY29sbGVjdGlvbltpXSA9PSBlbHQpIHJldHVybiBpO1xuICAgIHJldHVybiAtMTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNyZWF0ZU9iaihiYXNlLCBwcm9wcykge1xuICAgIGZ1bmN0aW9uIE9iaigpIHt9XG4gICAgT2JqLnByb3RvdHlwZSA9IGJhc2U7XG4gICAgdmFyIGluc3QgPSBuZXcgT2JqKCk7XG4gICAgaWYgKHByb3BzKSBjb3B5T2JqKHByb3BzLCBpbnN0KTtcbiAgICByZXR1cm4gaW5zdDtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNvcHlPYmoob2JqLCB0YXJnZXQpIHtcbiAgICBpZiAoIXRhcmdldCkgdGFyZ2V0ID0ge307XG4gICAgZm9yICh2YXIgcHJvcCBpbiBvYmopIGlmIChvYmouaGFzT3duUHJvcGVydHkocHJvcCkpIHRhcmdldFtwcm9wXSA9IG9ialtwcm9wXTtcbiAgICByZXR1cm4gdGFyZ2V0O1xuICB9XG5cbiAgZnVuY3Rpb24gZW1wdHlBcnJheShzaXplKSB7XG4gICAgZm9yICh2YXIgYSA9IFtdLCBpID0gMDsgaSA8IHNpemU7ICsraSkgYS5wdXNoKHVuZGVmaW5lZCk7XG4gICAgcmV0dXJuIGE7XG4gIH1cblxuICBmdW5jdGlvbiBiaW5kKGYpIHtcbiAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMSk7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKCl7cmV0dXJuIGYuYXBwbHkobnVsbCwgYXJncyk7fTtcbiAgfVxuXG4gIHZhciBub25BU0NJSVNpbmdsZUNhc2VXb3JkQ2hhciA9IC9bXFx1MDBkZlxcdTMwNDAtXFx1MzA5ZlxcdTMwYTAtXFx1MzBmZlxcdTM0MDAtXFx1NGRiNVxcdTRlMDAtXFx1OWZjY1xcdWFjMDAtXFx1ZDdhZl0vO1xuICBmdW5jdGlvbiBpc1dvcmRDaGFyKGNoKSB7XG4gICAgcmV0dXJuIC9cXHcvLnRlc3QoY2gpIHx8IGNoID4gXCJcXHg4MFwiICYmXG4gICAgICAoY2gudG9VcHBlckNhc2UoKSAhPSBjaC50b0xvd2VyQ2FzZSgpIHx8IG5vbkFTQ0lJU2luZ2xlQ2FzZVdvcmRDaGFyLnRlc3QoY2gpKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGlzRW1wdHkob2JqKSB7XG4gICAgZm9yICh2YXIgbiBpbiBvYmopIGlmIChvYmouaGFzT3duUHJvcGVydHkobikgJiYgb2JqW25dKSByZXR1cm4gZmFsc2U7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICB2YXIgZXh0ZW5kaW5nQ2hhcnMgPSAvW1xcdTAzMDAtXFx1MDM2ZlxcdTA0ODMtXFx1MDQ4OVxcdTA1OTEtXFx1MDViZFxcdTA1YmZcXHUwNWMxXFx1MDVjMlxcdTA1YzRcXHUwNWM1XFx1MDVjN1xcdTA2MTAtXFx1MDYxYVxcdTA2NGItXFx1MDY1ZVxcdTA2NzBcXHUwNmQ2LVxcdTA2ZGNcXHUwNmRlLVxcdTA2ZTRcXHUwNmU3XFx1MDZlOFxcdTA2ZWEtXFx1MDZlZFxcdTA3MTFcXHUwNzMwLVxcdTA3NGFcXHUwN2E2LVxcdTA3YjBcXHUwN2ViLVxcdTA3ZjNcXHUwODE2LVxcdTA4MTlcXHUwODFiLVxcdTA4MjNcXHUwODI1LVxcdTA4MjdcXHUwODI5LVxcdTA4MmRcXHUwOTAwLVxcdTA5MDJcXHUwOTNjXFx1MDk0MS1cXHUwOTQ4XFx1MDk0ZFxcdTA5NTEtXFx1MDk1NVxcdTA5NjJcXHUwOTYzXFx1MDk4MVxcdTA5YmNcXHUwOWJlXFx1MDljMS1cXHUwOWM0XFx1MDljZFxcdTA5ZDdcXHUwOWUyXFx1MDllM1xcdTBhMDFcXHUwYTAyXFx1MGEzY1xcdTBhNDFcXHUwYTQyXFx1MGE0N1xcdTBhNDhcXHUwYTRiLVxcdTBhNGRcXHUwYTUxXFx1MGE3MFxcdTBhNzFcXHUwYTc1XFx1MGE4MVxcdTBhODJcXHUwYWJjXFx1MGFjMS1cXHUwYWM1XFx1MGFjN1xcdTBhYzhcXHUwYWNkXFx1MGFlMlxcdTBhZTNcXHUwYjAxXFx1MGIzY1xcdTBiM2VcXHUwYjNmXFx1MGI0MS1cXHUwYjQ0XFx1MGI0ZFxcdTBiNTZcXHUwYjU3XFx1MGI2MlxcdTBiNjNcXHUwYjgyXFx1MGJiZVxcdTBiYzBcXHUwYmNkXFx1MGJkN1xcdTBjM2UtXFx1MGM0MFxcdTBjNDYtXFx1MGM0OFxcdTBjNGEtXFx1MGM0ZFxcdTBjNTVcXHUwYzU2XFx1MGM2MlxcdTBjNjNcXHUwY2JjXFx1MGNiZlxcdTBjYzJcXHUwY2M2XFx1MGNjY1xcdTBjY2RcXHUwY2Q1XFx1MGNkNlxcdTBjZTJcXHUwY2UzXFx1MGQzZVxcdTBkNDEtXFx1MGQ0NFxcdTBkNGRcXHUwZDU3XFx1MGQ2MlxcdTBkNjNcXHUwZGNhXFx1MGRjZlxcdTBkZDItXFx1MGRkNFxcdTBkZDZcXHUwZGRmXFx1MGUzMVxcdTBlMzQtXFx1MGUzYVxcdTBlNDctXFx1MGU0ZVxcdTBlYjFcXHUwZWI0LVxcdTBlYjlcXHUwZWJiXFx1MGViY1xcdTBlYzgtXFx1MGVjZFxcdTBmMThcXHUwZjE5XFx1MGYzNVxcdTBmMzdcXHUwZjM5XFx1MGY3MS1cXHUwZjdlXFx1MGY4MC1cXHUwZjg0XFx1MGY4NlxcdTBmODdcXHUwZjkwLVxcdTBmOTdcXHUwZjk5LVxcdTBmYmNcXHUwZmM2XFx1MTAyZC1cXHUxMDMwXFx1MTAzMi1cXHUxMDM3XFx1MTAzOVxcdTEwM2FcXHUxMDNkXFx1MTAzZVxcdTEwNThcXHUxMDU5XFx1MTA1ZS1cXHUxMDYwXFx1MTA3MS1cXHUxMDc0XFx1MTA4MlxcdTEwODVcXHUxMDg2XFx1MTA4ZFxcdTEwOWRcXHUxMzVmXFx1MTcxMi1cXHUxNzE0XFx1MTczMi1cXHUxNzM0XFx1MTc1MlxcdTE3NTNcXHUxNzcyXFx1MTc3M1xcdTE3YjctXFx1MTdiZFxcdTE3YzZcXHUxN2M5LVxcdTE3ZDNcXHUxN2RkXFx1MTgwYi1cXHUxODBkXFx1MThhOVxcdTE5MjAtXFx1MTkyMlxcdTE5MjdcXHUxOTI4XFx1MTkzMlxcdTE5MzktXFx1MTkzYlxcdTFhMTdcXHUxYTE4XFx1MWE1NlxcdTFhNTgtXFx1MWE1ZVxcdTFhNjBcXHUxYTYyXFx1MWE2NS1cXHUxYTZjXFx1MWE3My1cXHUxYTdjXFx1MWE3ZlxcdTFiMDAtXFx1MWIwM1xcdTFiMzRcXHUxYjM2LVxcdTFiM2FcXHUxYjNjXFx1MWI0MlxcdTFiNmItXFx1MWI3M1xcdTFiODBcXHUxYjgxXFx1MWJhMi1cXHUxYmE1XFx1MWJhOFxcdTFiYTlcXHUxYzJjLVxcdTFjMzNcXHUxYzM2XFx1MWMzN1xcdTFjZDAtXFx1MWNkMlxcdTFjZDQtXFx1MWNlMFxcdTFjZTItXFx1MWNlOFxcdTFjZWRcXHUxZGMwLVxcdTFkZTZcXHUxZGZkLVxcdTFkZmZcXHUyMDBjXFx1MjAwZFxcdTIwZDAtXFx1MjBmMFxcdTJjZWYtXFx1MmNmMVxcdTJkZTAtXFx1MmRmZlxcdTMwMmEtXFx1MzAyZlxcdTMwOTlcXHUzMDlhXFx1YTY2Zi1cXHVhNjcyXFx1YTY3Y1xcdWE2N2RcXHVhNmYwXFx1YTZmMVxcdWE4MDJcXHVhODA2XFx1YTgwYlxcdWE4MjVcXHVhODI2XFx1YThjNFxcdWE4ZTAtXFx1YThmMVxcdWE5MjYtXFx1YTkyZFxcdWE5NDctXFx1YTk1MVxcdWE5ODAtXFx1YTk4MlxcdWE5YjNcXHVhOWI2LVxcdWE5YjlcXHVhOWJjXFx1YWEyOS1cXHVhYTJlXFx1YWEzMVxcdWFhMzJcXHVhYTM1XFx1YWEzNlxcdWFhNDNcXHVhYTRjXFx1YWFiMFxcdWFhYjItXFx1YWFiNFxcdWFhYjdcXHVhYWI4XFx1YWFiZVxcdWFhYmZcXHVhYWMxXFx1YWJlNVxcdWFiZThcXHVhYmVkXFx1ZGMwMC1cXHVkZmZmXFx1ZmIxZVxcdWZlMDAtXFx1ZmUwZlxcdWZlMjAtXFx1ZmUyNlxcdWZmOWVcXHVmZjlmXS87XG4gIGZ1bmN0aW9uIGlzRXh0ZW5kaW5nQ2hhcihjaCkgeyByZXR1cm4gY2guY2hhckNvZGVBdCgwKSA+PSA3NjggJiYgZXh0ZW5kaW5nQ2hhcnMudGVzdChjaCk7IH1cblxuICAvLyBET00gVVRJTElUSUVTXG5cbiAgZnVuY3Rpb24gZWx0KHRhZywgY29udGVudCwgY2xhc3NOYW1lLCBzdHlsZSkge1xuICAgIHZhciBlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCh0YWcpO1xuICAgIGlmIChjbGFzc05hbWUpIGUuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICAgIGlmIChzdHlsZSkgZS5zdHlsZS5jc3NUZXh0ID0gc3R5bGU7XG4gICAgaWYgKHR5cGVvZiBjb250ZW50ID09IFwic3RyaW5nXCIpIHNldFRleHRDb250ZW50KGUsIGNvbnRlbnQpO1xuICAgIGVsc2UgaWYgKGNvbnRlbnQpIGZvciAodmFyIGkgPSAwOyBpIDwgY29udGVudC5sZW5ndGg7ICsraSkgZS5hcHBlbmRDaGlsZChjb250ZW50W2ldKTtcbiAgICByZXR1cm4gZTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHJlbW92ZUNoaWxkcmVuKGUpIHtcbiAgICBmb3IgKHZhciBjb3VudCA9IGUuY2hpbGROb2Rlcy5sZW5ndGg7IGNvdW50ID4gMDsgLS1jb3VudClcbiAgICAgIGUucmVtb3ZlQ2hpbGQoZS5maXJzdENoaWxkKTtcbiAgICByZXR1cm4gZTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHJlbW92ZUNoaWxkcmVuQW5kQWRkKHBhcmVudCwgZSkge1xuICAgIHJldHVybiByZW1vdmVDaGlsZHJlbihwYXJlbnQpLmFwcGVuZENoaWxkKGUpO1xuICB9XG5cbiAgZnVuY3Rpb24gc2V0VGV4dENvbnRlbnQoZSwgc3RyKSB7XG4gICAgaWYgKGllX2x0OSkge1xuICAgICAgZS5pbm5lckhUTUwgPSBcIlwiO1xuICAgICAgZS5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZShzdHIpKTtcbiAgICB9IGVsc2UgZS50ZXh0Q29udGVudCA9IHN0cjtcbiAgfVxuXG4gIGZ1bmN0aW9uIGdldFJlY3Qobm9kZSkge1xuICAgIHJldHVybiBub2RlLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICB9XG4gIENvZGVNaXJyb3IucmVwbGFjZUdldFJlY3QgPSBmdW5jdGlvbihmKSB7IGdldFJlY3QgPSBmOyB9O1xuXG4gIC8vIEZFQVRVUkUgREVURUNUSU9OXG5cbiAgLy8gRGV0ZWN0IGRyYWctYW5kLWRyb3BcbiAgdmFyIGRyYWdBbmREcm9wID0gZnVuY3Rpb24oKSB7XG4gICAgLy8gVGhlcmUgaXMgKnNvbWUqIGtpbmQgb2YgZHJhZy1hbmQtZHJvcCBzdXBwb3J0IGluIElFNi04LCBidXQgSVxuICAgIC8vIGNvdWxkbid0IGdldCBpdCB0byB3b3JrIHlldC5cbiAgICBpZiAoaWVfbHQ5KSByZXR1cm4gZmFsc2U7XG4gICAgdmFyIGRpdiA9IGVsdCgnZGl2Jyk7XG4gICAgcmV0dXJuIFwiZHJhZ2dhYmxlXCIgaW4gZGl2IHx8IFwiZHJhZ0Ryb3BcIiBpbiBkaXY7XG4gIH0oKTtcblxuICAvLyBGb3IgYSByZWFzb24gSSBoYXZlIHlldCB0byBmaWd1cmUgb3V0LCBzb21lIGJyb3dzZXJzIGRpc2FsbG93XG4gIC8vIHdvcmQgd3JhcHBpbmcgYmV0d2VlbiBjZXJ0YWluIGNoYXJhY3RlcnMgKm9ubHkqIGlmIGEgbmV3IGlubGluZVxuICAvLyBlbGVtZW50IGlzIHN0YXJ0ZWQgYmV0d2VlbiB0aGVtLiBUaGlzIG1ha2VzIGl0IGhhcmQgdG8gcmVsaWFibHlcbiAgLy8gbWVhc3VyZSB0aGUgcG9zaXRpb24gb2YgdGhpbmdzLCBzaW5jZSB0aGF0IHJlcXVpcmVzIGluc2VydGluZyBhblxuICAvLyBleHRyYSBzcGFuLiBUaGlzIHRlcnJpYmx5IGZyYWdpbGUgc2V0IG9mIHRlc3RzIG1hdGNoZXMgdGhlXG4gIC8vIGNoYXJhY3RlciBjb21iaW5hdGlvbnMgdGhhdCBzdWZmZXIgZnJvbSB0aGlzIHBoZW5vbWVub24gb24gdGhlXG4gIC8vIHZhcmlvdXMgYnJvd3NlcnMuXG4gIGZ1bmN0aW9uIHNwYW5BZmZlY3RzV3JhcHBpbmcoKSB7IHJldHVybiBmYWxzZTsgfVxuICBpZiAoZ2Vja28pIC8vIE9ubHkgZm9yIFwiJCdcIlxuICAgIHNwYW5BZmZlY3RzV3JhcHBpbmcgPSBmdW5jdGlvbihzdHIsIGkpIHtcbiAgICAgIHJldHVybiBzdHIuY2hhckNvZGVBdChpIC0gMSkgPT0gMzYgJiYgc3RyLmNoYXJDb2RlQXQoaSkgPT0gMzk7XG4gICAgfTtcbiAgZWxzZSBpZiAoc2FmYXJpICYmICEvVmVyc2lvblxcLyhbNi05XXxcXGRcXGQpXFxiLy50ZXN0KG5hdmlnYXRvci51c2VyQWdlbnQpKVxuICAgIHNwYW5BZmZlY3RzV3JhcHBpbmcgPSBmdW5jdGlvbihzdHIsIGkpIHtcbiAgICAgIHJldHVybiAvXFwtW14gXFwtP118XFw/W14gIVxcJ1xcXCJcXCksLlxcLVxcLzo7XFw/XFxdXFx9XS8udGVzdChzdHIuc2xpY2UoaSAtIDEsIGkgKyAxKSk7XG4gICAgfTtcbiAgZWxzZSBpZiAod2Via2l0ICYmIC9DaHJvbWVcXC8oPzoyOXxbMy05XVxcZHxcXGRcXGRcXGQpXFwuLy50ZXN0KG5hdmlnYXRvci51c2VyQWdlbnQpKVxuICAgIHNwYW5BZmZlY3RzV3JhcHBpbmcgPSBmdW5jdGlvbihzdHIsIGkpIHtcbiAgICAgIHZhciBjb2RlID0gc3RyLmNoYXJDb2RlQXQoaSAtIDEpO1xuICAgICAgcmV0dXJuIGNvZGUgPj0gODIwOCAmJiBjb2RlIDw9IDgyMTI7XG4gICAgfTtcbiAgZWxzZSBpZiAod2Via2l0KVxuICAgIHNwYW5BZmZlY3RzV3JhcHBpbmcgPSBmdW5jdGlvbihzdHIsIGkpIHtcbiAgICAgIGlmIChpID4gMSAmJiBzdHIuY2hhckNvZGVBdChpIC0gMSkgPT0gNDUpIHtcbiAgICAgICAgaWYgKC9cXHcvLnRlc3Qoc3RyLmNoYXJBdChpIC0gMikpICYmIC9bXlxcLT9cXC5dLy50ZXN0KHN0ci5jaGFyQXQoaSkpKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgaWYgKGkgPiAyICYmIC9bXFxkXFwuLF0vLnRlc3Qoc3RyLmNoYXJBdChpIC0gMikpICYmIC9bXFxkXFwuLF0vLnRlc3Qoc3RyLmNoYXJBdChpKSkpIHJldHVybiBmYWxzZTtcbiAgICAgIH1cbiAgICAgIHJldHVybiAvW34hIyUmKik9K31cXF1cXFxcfFxcXCJcXC4+LDo7XVsoe1s8XXwtW15cXC0/XFwuXFx1MjAxMC1cXHUyMDFmXFx1MjAyNl18XFw/W1xcd35gQCMkJVxcXiYqKF89K3tbfD48XXxcXHUyMDI2W1xcd35gQCMkJVxcXiYqKF89K3tbPjxdLy50ZXN0KHN0ci5zbGljZShpIC0gMSwgaSArIDEpKTtcbiAgICB9O1xuXG4gIHZhciBrbm93blNjcm9sbGJhcldpZHRoO1xuICBmdW5jdGlvbiBzY3JvbGxiYXJXaWR0aChtZWFzdXJlKSB7XG4gICAgaWYgKGtub3duU2Nyb2xsYmFyV2lkdGggIT0gbnVsbCkgcmV0dXJuIGtub3duU2Nyb2xsYmFyV2lkdGg7XG4gICAgdmFyIHRlc3QgPSBlbHQoXCJkaXZcIiwgbnVsbCwgbnVsbCwgXCJ3aWR0aDogNTBweDsgaGVpZ2h0OiA1MHB4OyBvdmVyZmxvdy14OiBzY3JvbGxcIik7XG4gICAgcmVtb3ZlQ2hpbGRyZW5BbmRBZGQobWVhc3VyZSwgdGVzdCk7XG4gICAgaWYgKHRlc3Qub2Zmc2V0V2lkdGgpXG4gICAgICBrbm93blNjcm9sbGJhcldpZHRoID0gdGVzdC5vZmZzZXRIZWlnaHQgLSB0ZXN0LmNsaWVudEhlaWdodDtcbiAgICByZXR1cm4ga25vd25TY3JvbGxiYXJXaWR0aCB8fCAwO1xuICB9XG5cbiAgdmFyIHp3c3BTdXBwb3J0ZWQ7XG4gIGZ1bmN0aW9uIHplcm9XaWR0aEVsZW1lbnQobWVhc3VyZSkge1xuICAgIGlmICh6d3NwU3VwcG9ydGVkID09IG51bGwpIHtcbiAgICAgIHZhciB0ZXN0ID0gZWx0KFwic3BhblwiLCBcIlxcdTIwMGJcIik7XG4gICAgICByZW1vdmVDaGlsZHJlbkFuZEFkZChtZWFzdXJlLCBlbHQoXCJzcGFuXCIsIFt0ZXN0LCBkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZShcInhcIildKSk7XG4gICAgICBpZiAobWVhc3VyZS5maXJzdENoaWxkLm9mZnNldEhlaWdodCAhPSAwKVxuICAgICAgICB6d3NwU3VwcG9ydGVkID0gdGVzdC5vZmZzZXRXaWR0aCA8PSAxICYmIHRlc3Qub2Zmc2V0SGVpZ2h0ID4gMiAmJiAhaWVfbHQ4O1xuICAgIH1cbiAgICBpZiAoendzcFN1cHBvcnRlZCkgcmV0dXJuIGVsdChcInNwYW5cIiwgXCJcXHUyMDBiXCIpO1xuICAgIGVsc2UgcmV0dXJuIGVsdChcInNwYW5cIiwgXCJcXHUwMGEwXCIsIG51bGwsIFwiZGlzcGxheTogaW5saW5lLWJsb2NrOyB3aWR0aDogMXB4OyBtYXJnaW4tcmlnaHQ6IC0xcHhcIik7XG4gIH1cblxuICAvLyBTZWUgaWYgXCJcIi5zcGxpdCBpcyB0aGUgYnJva2VuIElFIHZlcnNpb24sIGlmIHNvLCBwcm92aWRlIGFuXG4gIC8vIGFsdGVybmF0aXZlIHdheSB0byBzcGxpdCBsaW5lcy5cbiAgdmFyIHNwbGl0TGluZXMgPSBcIlxcblxcbmJcIi5zcGxpdCgvXFxuLykubGVuZ3RoICE9IDMgPyBmdW5jdGlvbihzdHJpbmcpIHtcbiAgICB2YXIgcG9zID0gMCwgcmVzdWx0ID0gW10sIGwgPSBzdHJpbmcubGVuZ3RoO1xuICAgIHdoaWxlIChwb3MgPD0gbCkge1xuICAgICAgdmFyIG5sID0gc3RyaW5nLmluZGV4T2YoXCJcXG5cIiwgcG9zKTtcbiAgICAgIGlmIChubCA9PSAtMSkgbmwgPSBzdHJpbmcubGVuZ3RoO1xuICAgICAgdmFyIGxpbmUgPSBzdHJpbmcuc2xpY2UocG9zLCBzdHJpbmcuY2hhckF0KG5sIC0gMSkgPT0gXCJcXHJcIiA/IG5sIC0gMSA6IG5sKTtcbiAgICAgIHZhciBydCA9IGxpbmUuaW5kZXhPZihcIlxcclwiKTtcbiAgICAgIGlmIChydCAhPSAtMSkge1xuICAgICAgICByZXN1bHQucHVzaChsaW5lLnNsaWNlKDAsIHJ0KSk7XG4gICAgICAgIHBvcyArPSBydCArIDE7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXN1bHQucHVzaChsaW5lKTtcbiAgICAgICAgcG9zID0gbmwgKyAxO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9IDogZnVuY3Rpb24oc3RyaW5nKXtyZXR1cm4gc3RyaW5nLnNwbGl0KC9cXHJcXG4/fFxcbi8pO307XG4gIENvZGVNaXJyb3Iuc3BsaXRMaW5lcyA9IHNwbGl0TGluZXM7XG5cbiAgdmFyIGhhc1NlbGVjdGlvbiA9IHdpbmRvdy5nZXRTZWxlY3Rpb24gPyBmdW5jdGlvbih0ZSkge1xuICAgIHRyeSB7IHJldHVybiB0ZS5zZWxlY3Rpb25TdGFydCAhPSB0ZS5zZWxlY3Rpb25FbmQ7IH1cbiAgICBjYXRjaChlKSB7IHJldHVybiBmYWxzZTsgfVxuICB9IDogZnVuY3Rpb24odGUpIHtcbiAgICB0cnkge3ZhciByYW5nZSA9IHRlLm93bmVyRG9jdW1lbnQuc2VsZWN0aW9uLmNyZWF0ZVJhbmdlKCk7fVxuICAgIGNhdGNoKGUpIHt9XG4gICAgaWYgKCFyYW5nZSB8fCByYW5nZS5wYXJlbnRFbGVtZW50KCkgIT0gdGUpIHJldHVybiBmYWxzZTtcbiAgICByZXR1cm4gcmFuZ2UuY29tcGFyZUVuZFBvaW50cyhcIlN0YXJ0VG9FbmRcIiwgcmFuZ2UpICE9IDA7XG4gIH07XG5cbiAgdmFyIGhhc0NvcHlFdmVudCA9IChmdW5jdGlvbigpIHtcbiAgICB2YXIgZSA9IGVsdChcImRpdlwiKTtcbiAgICBpZiAoXCJvbmNvcHlcIiBpbiBlKSByZXR1cm4gdHJ1ZTtcbiAgICBlLnNldEF0dHJpYnV0ZShcIm9uY29weVwiLCBcInJldHVybjtcIik7XG4gICAgcmV0dXJuIHR5cGVvZiBlLm9uY29weSA9PSAnZnVuY3Rpb24nO1xuICB9KSgpO1xuXG4gIC8vIEtFWSBOQU1JTkdcblxuICB2YXIga2V5TmFtZXMgPSB7MzogXCJFbnRlclwiLCA4OiBcIkJhY2tzcGFjZVwiLCA5OiBcIlRhYlwiLCAxMzogXCJFbnRlclwiLCAxNjogXCJTaGlmdFwiLCAxNzogXCJDdHJsXCIsIDE4OiBcIkFsdFwiLFxuICAgICAgICAgICAgICAgICAgMTk6IFwiUGF1c2VcIiwgMjA6IFwiQ2Fwc0xvY2tcIiwgMjc6IFwiRXNjXCIsIDMyOiBcIlNwYWNlXCIsIDMzOiBcIlBhZ2VVcFwiLCAzNDogXCJQYWdlRG93blwiLCAzNTogXCJFbmRcIixcbiAgICAgICAgICAgICAgICAgIDM2OiBcIkhvbWVcIiwgMzc6IFwiTGVmdFwiLCAzODogXCJVcFwiLCAzOTogXCJSaWdodFwiLCA0MDogXCJEb3duXCIsIDQ0OiBcIlByaW50U2NyblwiLCA0NTogXCJJbnNlcnRcIixcbiAgICAgICAgICAgICAgICAgIDQ2OiBcIkRlbGV0ZVwiLCA1OTogXCI7XCIsIDYxOiBcIj1cIiwgOTE6IFwiTW9kXCIsIDkyOiBcIk1vZFwiLCA5MzogXCJNb2RcIiwgMTA3OiBcIj1cIiwgMTA5OiBcIi1cIiwgMTI3OiBcIkRlbGV0ZVwiLFxuICAgICAgICAgICAgICAgICAgMTczOiBcIi1cIiwgMTg2OiBcIjtcIiwgMTg3OiBcIj1cIiwgMTg4OiBcIixcIiwgMTg5OiBcIi1cIiwgMTkwOiBcIi5cIiwgMTkxOiBcIi9cIiwgMTkyOiBcImBcIiwgMjE5OiBcIltcIiwgMjIwOiBcIlxcXFxcIixcbiAgICAgICAgICAgICAgICAgIDIyMTogXCJdXCIsIDIyMjogXCInXCIsIDYzMjMyOiBcIlVwXCIsIDYzMjMzOiBcIkRvd25cIiwgNjMyMzQ6IFwiTGVmdFwiLCA2MzIzNTogXCJSaWdodFwiLCA2MzI3MjogXCJEZWxldGVcIixcbiAgICAgICAgICAgICAgICAgIDYzMjczOiBcIkhvbWVcIiwgNjMyNzU6IFwiRW5kXCIsIDYzMjc2OiBcIlBhZ2VVcFwiLCA2MzI3NzogXCJQYWdlRG93blwiLCA2MzMwMjogXCJJbnNlcnRcIn07XG4gIENvZGVNaXJyb3Iua2V5TmFtZXMgPSBrZXlOYW1lcztcbiAgKGZ1bmN0aW9uKCkge1xuICAgIC8vIE51bWJlciBrZXlzXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCAxMDsgaSsrKSBrZXlOYW1lc1tpICsgNDhdID0ga2V5TmFtZXNbaSArIDk2XSA9IFN0cmluZyhpKTtcbiAgICAvLyBBbHBoYWJldGljIGtleXNcbiAgICBmb3IgKHZhciBpID0gNjU7IGkgPD0gOTA7IGkrKykga2V5TmFtZXNbaV0gPSBTdHJpbmcuZnJvbUNoYXJDb2RlKGkpO1xuICAgIC8vIEZ1bmN0aW9uIGtleXNcbiAgICBmb3IgKHZhciBpID0gMTsgaSA8PSAxMjsgaSsrKSBrZXlOYW1lc1tpICsgMTExXSA9IGtleU5hbWVzW2kgKyA2MzIzNV0gPSBcIkZcIiArIGk7XG4gIH0pKCk7XG5cbiAgLy8gQklESSBIRUxQRVJTXG5cbiAgZnVuY3Rpb24gaXRlcmF0ZUJpZGlTZWN0aW9ucyhvcmRlciwgZnJvbSwgdG8sIGYpIHtcbiAgICBpZiAoIW9yZGVyKSByZXR1cm4gZihmcm9tLCB0bywgXCJsdHJcIik7XG4gICAgdmFyIGZvdW5kID0gZmFsc2U7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBvcmRlci5sZW5ndGg7ICsraSkge1xuICAgICAgdmFyIHBhcnQgPSBvcmRlcltpXTtcbiAgICAgIGlmIChwYXJ0LmZyb20gPCB0byAmJiBwYXJ0LnRvID4gZnJvbSB8fCBmcm9tID09IHRvICYmIHBhcnQudG8gPT0gZnJvbSkge1xuICAgICAgICBmKE1hdGgubWF4KHBhcnQuZnJvbSwgZnJvbSksIE1hdGgubWluKHBhcnQudG8sIHRvKSwgcGFydC5sZXZlbCA9PSAxID8gXCJydGxcIiA6IFwibHRyXCIpO1xuICAgICAgICBmb3VuZCA9IHRydWU7XG4gICAgICB9XG4gICAgfVxuICAgIGlmICghZm91bmQpIGYoZnJvbSwgdG8sIFwibHRyXCIpO1xuICB9XG5cbiAgZnVuY3Rpb24gYmlkaUxlZnQocGFydCkgeyByZXR1cm4gcGFydC5sZXZlbCAlIDIgPyBwYXJ0LnRvIDogcGFydC5mcm9tOyB9XG4gIGZ1bmN0aW9uIGJpZGlSaWdodChwYXJ0KSB7IHJldHVybiBwYXJ0LmxldmVsICUgMiA/IHBhcnQuZnJvbSA6IHBhcnQudG87IH1cblxuICBmdW5jdGlvbiBsaW5lTGVmdChsaW5lKSB7IHZhciBvcmRlciA9IGdldE9yZGVyKGxpbmUpOyByZXR1cm4gb3JkZXIgPyBiaWRpTGVmdChvcmRlclswXSkgOiAwOyB9XG4gIGZ1bmN0aW9uIGxpbmVSaWdodChsaW5lKSB7XG4gICAgdmFyIG9yZGVyID0gZ2V0T3JkZXIobGluZSk7XG4gICAgaWYgKCFvcmRlcikgcmV0dXJuIGxpbmUudGV4dC5sZW5ndGg7XG4gICAgcmV0dXJuIGJpZGlSaWdodChsc3Qob3JkZXIpKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGxpbmVTdGFydChjbSwgbGluZU4pIHtcbiAgICB2YXIgbGluZSA9IGdldExpbmUoY20uZG9jLCBsaW5lTik7XG4gICAgdmFyIHZpc3VhbCA9IHZpc3VhbExpbmUoY20uZG9jLCBsaW5lKTtcbiAgICBpZiAodmlzdWFsICE9IGxpbmUpIGxpbmVOID0gbGluZU5vKHZpc3VhbCk7XG4gICAgdmFyIG9yZGVyID0gZ2V0T3JkZXIodmlzdWFsKTtcbiAgICB2YXIgY2ggPSAhb3JkZXIgPyAwIDogb3JkZXJbMF0ubGV2ZWwgJSAyID8gbGluZVJpZ2h0KHZpc3VhbCkgOiBsaW5lTGVmdCh2aXN1YWwpO1xuICAgIHJldHVybiBQb3MobGluZU4sIGNoKTtcbiAgfVxuICBmdW5jdGlvbiBsaW5lRW5kKGNtLCBsaW5lTikge1xuICAgIHZhciBtZXJnZWQsIGxpbmU7XG4gICAgd2hpbGUgKG1lcmdlZCA9IGNvbGxhcHNlZFNwYW5BdEVuZChsaW5lID0gZ2V0TGluZShjbS5kb2MsIGxpbmVOKSkpXG4gICAgICBsaW5lTiA9IG1lcmdlZC5maW5kKCkudG8ubGluZTtcbiAgICB2YXIgb3JkZXIgPSBnZXRPcmRlcihsaW5lKTtcbiAgICB2YXIgY2ggPSAhb3JkZXIgPyBsaW5lLnRleHQubGVuZ3RoIDogb3JkZXJbMF0ubGV2ZWwgJSAyID8gbGluZUxlZnQobGluZSkgOiBsaW5lUmlnaHQobGluZSk7XG4gICAgcmV0dXJuIFBvcyhsaW5lTiwgY2gpO1xuICB9XG5cbiAgZnVuY3Rpb24gY29tcGFyZUJpZGlMZXZlbChvcmRlciwgYSwgYikge1xuICAgIHZhciBsaW5lZGlyID0gb3JkZXJbMF0ubGV2ZWw7XG4gICAgaWYgKGEgPT0gbGluZWRpcikgcmV0dXJuIHRydWU7XG4gICAgaWYgKGIgPT0gbGluZWRpcikgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiBhIDwgYjtcbiAgfVxuICB2YXIgYmlkaU90aGVyO1xuICBmdW5jdGlvbiBnZXRCaWRpUGFydEF0KG9yZGVyLCBwb3MpIHtcbiAgICBiaWRpT3RoZXIgPSBudWxsO1xuICAgIGZvciAodmFyIGkgPSAwLCBmb3VuZDsgaSA8IG9yZGVyLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YXIgY3VyID0gb3JkZXJbaV07XG4gICAgICBpZiAoY3VyLmZyb20gPCBwb3MgJiYgY3VyLnRvID4gcG9zKSByZXR1cm4gaTtcbiAgICAgIGlmICgoY3VyLmZyb20gPT0gcG9zIHx8IGN1ci50byA9PSBwb3MpKSB7XG4gICAgICAgIGlmIChmb3VuZCA9PSBudWxsKSB7XG4gICAgICAgICAgZm91bmQgPSBpO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbXBhcmVCaWRpTGV2ZWwob3JkZXIsIGN1ci5sZXZlbCwgb3JkZXJbZm91bmRdLmxldmVsKSkge1xuICAgICAgICAgIGlmIChjdXIuZnJvbSAhPSBjdXIudG8pIGJpZGlPdGhlciA9IGZvdW5kO1xuICAgICAgICAgIHJldHVybiBpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGlmIChjdXIuZnJvbSAhPSBjdXIudG8pIGJpZGlPdGhlciA9IGk7XG4gICAgICAgICAgcmV0dXJuIGZvdW5kO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBmb3VuZDtcbiAgfVxuXG4gIGZ1bmN0aW9uIG1vdmVJbkxpbmUobGluZSwgcG9zLCBkaXIsIGJ5VW5pdCkge1xuICAgIGlmICghYnlVbml0KSByZXR1cm4gcG9zICsgZGlyO1xuICAgIGRvIHBvcyArPSBkaXI7XG4gICAgd2hpbGUgKHBvcyA+IDAgJiYgaXNFeHRlbmRpbmdDaGFyKGxpbmUudGV4dC5jaGFyQXQocG9zKSkpO1xuICAgIHJldHVybiBwb3M7XG4gIH1cblxuICAvLyBUaGlzIGlzIHNvbWV3aGF0IGludm9sdmVkLiBJdCBpcyBuZWVkZWQgaW4gb3JkZXIgdG8gbW92ZVxuICAvLyAndmlzdWFsbHknIHRocm91Z2ggYmktZGlyZWN0aW9uYWwgdGV4dCAtLSBpLmUuLCBwcmVzc2luZyBsZWZ0XG4gIC8vIHNob3VsZCBtYWtlIHRoZSBjdXJzb3IgZ28gbGVmdCwgZXZlbiB3aGVuIGluIFJUTCB0ZXh0LiBUaGVcbiAgLy8gdHJpY2t5IHBhcnQgaXMgdGhlICdqdW1wcycsIHdoZXJlIFJUTCBhbmQgTFRSIHRleHQgdG91Y2ggZWFjaFxuICAvLyBvdGhlci4gVGhpcyBvZnRlbiByZXF1aXJlcyB0aGUgY3Vyc29yIG9mZnNldCB0byBtb3ZlIG1vcmUgdGhhblxuICAvLyBvbmUgdW5pdCwgaW4gb3JkZXIgdG8gdmlzdWFsbHkgbW92ZSBvbmUgdW5pdC5cbiAgZnVuY3Rpb24gbW92ZVZpc3VhbGx5KGxpbmUsIHN0YXJ0LCBkaXIsIGJ5VW5pdCkge1xuICAgIHZhciBiaWRpID0gZ2V0T3JkZXIobGluZSk7XG4gICAgaWYgKCFiaWRpKSByZXR1cm4gbW92ZUxvZ2ljYWxseShsaW5lLCBzdGFydCwgZGlyLCBieVVuaXQpO1xuICAgIHZhciBwb3MgPSBnZXRCaWRpUGFydEF0KGJpZGksIHN0YXJ0KSwgcGFydCA9IGJpZGlbcG9zXTtcbiAgICB2YXIgdGFyZ2V0ID0gbW92ZUluTGluZShsaW5lLCBzdGFydCwgcGFydC5sZXZlbCAlIDIgPyAtZGlyIDogZGlyLCBieVVuaXQpO1xuXG4gICAgZm9yICg7Oykge1xuICAgICAgaWYgKHRhcmdldCA+IHBhcnQuZnJvbSAmJiB0YXJnZXQgPCBwYXJ0LnRvKSByZXR1cm4gdGFyZ2V0O1xuICAgICAgaWYgKHRhcmdldCA9PSBwYXJ0LmZyb20gfHwgdGFyZ2V0ID09IHBhcnQudG8pIHtcbiAgICAgICAgaWYgKGdldEJpZGlQYXJ0QXQoYmlkaSwgdGFyZ2V0KSA9PSBwb3MpIHJldHVybiB0YXJnZXQ7XG4gICAgICAgIHBhcnQgPSBiaWRpW3BvcyArPSBkaXJdO1xuICAgICAgICByZXR1cm4gKGRpciA+IDApID09IHBhcnQubGV2ZWwgJSAyID8gcGFydC50byA6IHBhcnQuZnJvbTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHBhcnQgPSBiaWRpW3BvcyArPSBkaXJdO1xuICAgICAgICBpZiAoIXBhcnQpIHJldHVybiBudWxsO1xuICAgICAgICBpZiAoKGRpciA+IDApID09IHBhcnQubGV2ZWwgJSAyKVxuICAgICAgICAgIHRhcmdldCA9IG1vdmVJbkxpbmUobGluZSwgcGFydC50bywgLTEsIGJ5VW5pdCk7XG4gICAgICAgIGVsc2VcbiAgICAgICAgICB0YXJnZXQgPSBtb3ZlSW5MaW5lKGxpbmUsIHBhcnQuZnJvbSwgMSwgYnlVbml0KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBtb3ZlTG9naWNhbGx5KGxpbmUsIHN0YXJ0LCBkaXIsIGJ5VW5pdCkge1xuICAgIHZhciB0YXJnZXQgPSBzdGFydCArIGRpcjtcbiAgICBpZiAoYnlVbml0KSB3aGlsZSAodGFyZ2V0ID4gMCAmJiBpc0V4dGVuZGluZ0NoYXIobGluZS50ZXh0LmNoYXJBdCh0YXJnZXQpKSkgdGFyZ2V0ICs9IGRpcjtcbiAgICByZXR1cm4gdGFyZ2V0IDwgMCB8fCB0YXJnZXQgPiBsaW5lLnRleHQubGVuZ3RoID8gbnVsbCA6IHRhcmdldDtcbiAgfVxuXG4gIC8vIEJpZGlyZWN0aW9uYWwgb3JkZXJpbmcgYWxnb3JpdGhtXG4gIC8vIFNlZSBodHRwOi8vdW5pY29kZS5vcmcvcmVwb3J0cy90cjkvdHI5LTEzLmh0bWwgZm9yIHRoZSBhbGdvcml0aG1cbiAgLy8gdGhhdCB0aGlzIChwYXJ0aWFsbHkpIGltcGxlbWVudHMuXG5cbiAgLy8gT25lLWNoYXIgY29kZXMgdXNlZCBmb3IgY2hhcmFjdGVyIHR5cGVzOlxuICAvLyBMIChMKTogICBMZWZ0LXRvLVJpZ2h0XG4gIC8vIFIgKFIpOiAgIFJpZ2h0LXRvLUxlZnRcbiAgLy8gciAoQUwpOiAgUmlnaHQtdG8tTGVmdCBBcmFiaWNcbiAgLy8gMSAoRU4pOiAgRXVyb3BlYW4gTnVtYmVyXG4gIC8vICsgKEVTKTogIEV1cm9wZWFuIE51bWJlciBTZXBhcmF0b3JcbiAgLy8gJSAoRVQpOiAgRXVyb3BlYW4gTnVtYmVyIFRlcm1pbmF0b3JcbiAgLy8gbiAoQU4pOiAgQXJhYmljIE51bWJlclxuICAvLyAsIChDUyk6ICBDb21tb24gTnVtYmVyIFNlcGFyYXRvclxuICAvLyBtIChOU00pOiBOb24tU3BhY2luZyBNYXJrXG4gIC8vIGIgKEJOKTogIEJvdW5kYXJ5IE5ldXRyYWxcbiAgLy8gcyAoQik6ICAgUGFyYWdyYXBoIFNlcGFyYXRvclxuICAvLyB0IChTKTogICBTZWdtZW50IFNlcGFyYXRvclxuICAvLyB3IChXUyk6ICBXaGl0ZXNwYWNlXG4gIC8vIE4gKE9OKTogIE90aGVyIE5ldXRyYWxzXG5cbiAgLy8gUmV0dXJucyBudWxsIGlmIGNoYXJhY3RlcnMgYXJlIG9yZGVyZWQgYXMgdGhleSBhcHBlYXJcbiAgLy8gKGxlZnQtdG8tcmlnaHQpLCBvciBhbiBhcnJheSBvZiBzZWN0aW9ucyAoe2Zyb20sIHRvLCBsZXZlbH1cbiAgLy8gb2JqZWN0cykgaW4gdGhlIG9yZGVyIGluIHdoaWNoIHRoZXkgb2NjdXIgdmlzdWFsbHkuXG4gIHZhciBiaWRpT3JkZXJpbmcgPSAoZnVuY3Rpb24oKSB7XG4gICAgLy8gQ2hhcmFjdGVyIHR5cGVzIGZvciBjb2RlcG9pbnRzIDAgdG8gMHhmZlxuICAgIHZhciBsb3dUeXBlcyA9IFwiYmJiYmJiYmJidHN0d3NiYmJiYmJiYmJiYmJiYnNzc3R3Tk4lJSVOTk5OTk4sTixOMTExMTExMTExMU5OTk5OTk5MTExMTExMTExMTExMTExMTExMTExMTExMTE5OTk5OTkxMTExMTExMTExMTExMTExMTExMTExMTExMTk5OTmJiYmJiYnNiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYixOJSUlJU5OTk5MTk5OTk4lJTExTkxOTk4xTE5OTk5OTExMTExMTExMTExMTExMTExMTExMTExOTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTE5MTExMTExMTFwiO1xuICAgIC8vIENoYXJhY3RlciB0eXBlcyBmb3IgY29kZXBvaW50cyAweDYwMCB0byAweDZmZlxuICAgIHZhciBhcmFiaWNUeXBlcyA9IFwicnJycnJycnJycnJyLHJOTm1tbW1tbXJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJybW1tbW1tbW1tbW1tbW1ycnJycnJybm5ubm5ubm5ubiVubnJycm1ycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycm1tbW1tbW1tbW1tbW1tbW1tbW1ObW1tbXJycnJycnJycnJycnJycnJyclwiO1xuICAgIGZ1bmN0aW9uIGNoYXJUeXBlKGNvZGUpIHtcbiAgICAgIGlmIChjb2RlIDw9IDB4ZmYpIHJldHVybiBsb3dUeXBlcy5jaGFyQXQoY29kZSk7XG4gICAgICBlbHNlIGlmICgweDU5MCA8PSBjb2RlICYmIGNvZGUgPD0gMHg1ZjQpIHJldHVybiBcIlJcIjtcbiAgICAgIGVsc2UgaWYgKDB4NjAwIDw9IGNvZGUgJiYgY29kZSA8PSAweDZmZikgcmV0dXJuIGFyYWJpY1R5cGVzLmNoYXJBdChjb2RlIC0gMHg2MDApO1xuICAgICAgZWxzZSBpZiAoMHg3MDAgPD0gY29kZSAmJiBjb2RlIDw9IDB4OGFjKSByZXR1cm4gXCJyXCI7XG4gICAgICBlbHNlIHJldHVybiBcIkxcIjtcbiAgICB9XG5cbiAgICB2YXIgYmlkaVJFID0gL1tcXHUwNTkwLVxcdTA1ZjRcXHUwNjAwLVxcdTA2ZmZcXHUwNzAwLVxcdTA4YWNdLztcbiAgICB2YXIgaXNOZXV0cmFsID0gL1tzdHdOXS8sIGlzU3Ryb25nID0gL1tMUnJdLywgY291bnRzQXNMZWZ0ID0gL1tMYjFuXS8sIGNvdW50c0FzTnVtID0gL1sxbl0vO1xuICAgIC8vIEJyb3dzZXJzIHNlZW0gdG8gYWx3YXlzIHRyZWF0IHRoZSBib3VuZGFyaWVzIG9mIGJsb2NrIGVsZW1lbnRzIGFzIGJlaW5nIEwuXG4gICAgdmFyIG91dGVyVHlwZSA9IFwiTFwiO1xuXG4gICAgcmV0dXJuIGZ1bmN0aW9uKHN0cikge1xuICAgICAgaWYgKCFiaWRpUkUudGVzdChzdHIpKSByZXR1cm4gZmFsc2U7XG4gICAgICB2YXIgbGVuID0gc3RyLmxlbmd0aCwgdHlwZXMgPSBbXTtcbiAgICAgIGZvciAodmFyIGkgPSAwLCB0eXBlOyBpIDwgbGVuOyArK2kpXG4gICAgICAgIHR5cGVzLnB1c2godHlwZSA9IGNoYXJUeXBlKHN0ci5jaGFyQ29kZUF0KGkpKSk7XG5cbiAgICAgIC8vIFcxLiBFeGFtaW5lIGVhY2ggbm9uLXNwYWNpbmcgbWFyayAoTlNNKSBpbiB0aGUgbGV2ZWwgcnVuLCBhbmRcbiAgICAgIC8vIGNoYW5nZSB0aGUgdHlwZSBvZiB0aGUgTlNNIHRvIHRoZSB0eXBlIG9mIHRoZSBwcmV2aW91c1xuICAgICAgLy8gY2hhcmFjdGVyLiBJZiB0aGUgTlNNIGlzIGF0IHRoZSBzdGFydCBvZiB0aGUgbGV2ZWwgcnVuLCBpdCB3aWxsXG4gICAgICAvLyBnZXQgdGhlIHR5cGUgb2Ygc29yLlxuICAgICAgZm9yICh2YXIgaSA9IDAsIHByZXYgPSBvdXRlclR5cGU7IGkgPCBsZW47ICsraSkge1xuICAgICAgICB2YXIgdHlwZSA9IHR5cGVzW2ldO1xuICAgICAgICBpZiAodHlwZSA9PSBcIm1cIikgdHlwZXNbaV0gPSBwcmV2O1xuICAgICAgICBlbHNlIHByZXYgPSB0eXBlO1xuICAgICAgfVxuXG4gICAgICAvLyBXMi4gU2VhcmNoIGJhY2t3YXJkcyBmcm9tIGVhY2ggaW5zdGFuY2Ugb2YgYSBFdXJvcGVhbiBudW1iZXJcbiAgICAgIC8vIHVudGlsIHRoZSBmaXJzdCBzdHJvbmcgdHlwZSAoUiwgTCwgQUwsIG9yIHNvcikgaXMgZm91bmQuIElmIGFuXG4gICAgICAvLyBBTCBpcyBmb3VuZCwgY2hhbmdlIHRoZSB0eXBlIG9mIHRoZSBFdXJvcGVhbiBudW1iZXIgdG8gQXJhYmljXG4gICAgICAvLyBudW1iZXIuXG4gICAgICAvLyBXMy4gQ2hhbmdlIGFsbCBBTHMgdG8gUi5cbiAgICAgIGZvciAodmFyIGkgPSAwLCBjdXIgPSBvdXRlclR5cGU7IGkgPCBsZW47ICsraSkge1xuICAgICAgICB2YXIgdHlwZSA9IHR5cGVzW2ldO1xuICAgICAgICBpZiAodHlwZSA9PSBcIjFcIiAmJiBjdXIgPT0gXCJyXCIpIHR5cGVzW2ldID0gXCJuXCI7XG4gICAgICAgIGVsc2UgaWYgKGlzU3Ryb25nLnRlc3QodHlwZSkpIHsgY3VyID0gdHlwZTsgaWYgKHR5cGUgPT0gXCJyXCIpIHR5cGVzW2ldID0gXCJSXCI7IH1cbiAgICAgIH1cblxuICAgICAgLy8gVzQuIEEgc2luZ2xlIEV1cm9wZWFuIHNlcGFyYXRvciBiZXR3ZWVuIHR3byBFdXJvcGVhbiBudW1iZXJzXG4gICAgICAvLyBjaGFuZ2VzIHRvIGEgRXVyb3BlYW4gbnVtYmVyLiBBIHNpbmdsZSBjb21tb24gc2VwYXJhdG9yIGJldHdlZW5cbiAgICAgIC8vIHR3byBudW1iZXJzIG9mIHRoZSBzYW1lIHR5cGUgY2hhbmdlcyB0byB0aGF0IHR5cGUuXG4gICAgICBmb3IgKHZhciBpID0gMSwgcHJldiA9IHR5cGVzWzBdOyBpIDwgbGVuIC0gMTsgKytpKSB7XG4gICAgICAgIHZhciB0eXBlID0gdHlwZXNbaV07XG4gICAgICAgIGlmICh0eXBlID09IFwiK1wiICYmIHByZXYgPT0gXCIxXCIgJiYgdHlwZXNbaSsxXSA9PSBcIjFcIikgdHlwZXNbaV0gPSBcIjFcIjtcbiAgICAgICAgZWxzZSBpZiAodHlwZSA9PSBcIixcIiAmJiBwcmV2ID09IHR5cGVzW2krMV0gJiZcbiAgICAgICAgICAgICAgICAgKHByZXYgPT0gXCIxXCIgfHwgcHJldiA9PSBcIm5cIikpIHR5cGVzW2ldID0gcHJldjtcbiAgICAgICAgcHJldiA9IHR5cGU7XG4gICAgICB9XG5cbiAgICAgIC8vIFc1LiBBIHNlcXVlbmNlIG9mIEV1cm9wZWFuIHRlcm1pbmF0b3JzIGFkamFjZW50IHRvIEV1cm9wZWFuXG4gICAgICAvLyBudW1iZXJzIGNoYW5nZXMgdG8gYWxsIEV1cm9wZWFuIG51bWJlcnMuXG4gICAgICAvLyBXNi4gT3RoZXJ3aXNlLCBzZXBhcmF0b3JzIGFuZCB0ZXJtaW5hdG9ycyBjaGFuZ2UgdG8gT3RoZXJcbiAgICAgIC8vIE5ldXRyYWwuXG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbjsgKytpKSB7XG4gICAgICAgIHZhciB0eXBlID0gdHlwZXNbaV07XG4gICAgICAgIGlmICh0eXBlID09IFwiLFwiKSB0eXBlc1tpXSA9IFwiTlwiO1xuICAgICAgICBlbHNlIGlmICh0eXBlID09IFwiJVwiKSB7XG4gICAgICAgICAgZm9yICh2YXIgZW5kID0gaSArIDE7IGVuZCA8IGxlbiAmJiB0eXBlc1tlbmRdID09IFwiJVwiOyArK2VuZCkge31cbiAgICAgICAgICB2YXIgcmVwbGFjZSA9IChpICYmIHR5cGVzW2ktMV0gPT0gXCIhXCIpIHx8IChlbmQgPCBsZW4gJiYgdHlwZXNbZW5kXSA9PSBcIjFcIikgPyBcIjFcIiA6IFwiTlwiO1xuICAgICAgICAgIGZvciAodmFyIGogPSBpOyBqIDwgZW5kOyArK2opIHR5cGVzW2pdID0gcmVwbGFjZTtcbiAgICAgICAgICBpID0gZW5kIC0gMTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBXNy4gU2VhcmNoIGJhY2t3YXJkcyBmcm9tIGVhY2ggaW5zdGFuY2Ugb2YgYSBFdXJvcGVhbiBudW1iZXJcbiAgICAgIC8vIHVudGlsIHRoZSBmaXJzdCBzdHJvbmcgdHlwZSAoUiwgTCwgb3Igc29yKSBpcyBmb3VuZC4gSWYgYW4gTCBpc1xuICAgICAgLy8gZm91bmQsIHRoZW4gY2hhbmdlIHRoZSB0eXBlIG9mIHRoZSBFdXJvcGVhbiBudW1iZXIgdG8gTC5cbiAgICAgIGZvciAodmFyIGkgPSAwLCBjdXIgPSBvdXRlclR5cGU7IGkgPCBsZW47ICsraSkge1xuICAgICAgICB2YXIgdHlwZSA9IHR5cGVzW2ldO1xuICAgICAgICBpZiAoY3VyID09IFwiTFwiICYmIHR5cGUgPT0gXCIxXCIpIHR5cGVzW2ldID0gXCJMXCI7XG4gICAgICAgIGVsc2UgaWYgKGlzU3Ryb25nLnRlc3QodHlwZSkpIGN1ciA9IHR5cGU7XG4gICAgICB9XG5cbiAgICAgIC8vIE4xLiBBIHNlcXVlbmNlIG9mIG5ldXRyYWxzIHRha2VzIHRoZSBkaXJlY3Rpb24gb2YgdGhlXG4gICAgICAvLyBzdXJyb3VuZGluZyBzdHJvbmcgdGV4dCBpZiB0aGUgdGV4dCBvbiBib3RoIHNpZGVzIGhhcyB0aGUgc2FtZVxuICAgICAgLy8gZGlyZWN0aW9uLiBFdXJvcGVhbiBhbmQgQXJhYmljIG51bWJlcnMgYWN0IGFzIGlmIHRoZXkgd2VyZSBSIGluXG4gICAgICAvLyB0ZXJtcyBvZiB0aGVpciBpbmZsdWVuY2Ugb24gbmV1dHJhbHMuIFN0YXJ0LW9mLWxldmVsLXJ1biAoc29yKVxuICAgICAgLy8gYW5kIGVuZC1vZi1sZXZlbC1ydW4gKGVvcikgYXJlIHVzZWQgYXQgbGV2ZWwgcnVuIGJvdW5kYXJpZXMuXG4gICAgICAvLyBOMi4gQW55IHJlbWFpbmluZyBuZXV0cmFscyB0YWtlIHRoZSBlbWJlZGRpbmcgZGlyZWN0aW9uLlxuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW47ICsraSkge1xuICAgICAgICBpZiAoaXNOZXV0cmFsLnRlc3QodHlwZXNbaV0pKSB7XG4gICAgICAgICAgZm9yICh2YXIgZW5kID0gaSArIDE7IGVuZCA8IGxlbiAmJiBpc05ldXRyYWwudGVzdCh0eXBlc1tlbmRdKTsgKytlbmQpIHt9XG4gICAgICAgICAgdmFyIGJlZm9yZSA9IChpID8gdHlwZXNbaS0xXSA6IG91dGVyVHlwZSkgPT0gXCJMXCI7XG4gICAgICAgICAgdmFyIGFmdGVyID0gKGVuZCA8IGxlbiA/IHR5cGVzW2VuZF0gOiBvdXRlclR5cGUpID09IFwiTFwiO1xuICAgICAgICAgIHZhciByZXBsYWNlID0gYmVmb3JlIHx8IGFmdGVyID8gXCJMXCIgOiBcIlJcIjtcbiAgICAgICAgICBmb3IgKHZhciBqID0gaTsgaiA8IGVuZDsgKytqKSB0eXBlc1tqXSA9IHJlcGxhY2U7XG4gICAgICAgICAgaSA9IGVuZCAtIDE7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gSGVyZSB3ZSBkZXBhcnQgZnJvbSB0aGUgZG9jdW1lbnRlZCBhbGdvcml0aG0sIGluIG9yZGVyIHRvIGF2b2lkXG4gICAgICAvLyBidWlsZGluZyB1cCBhbiBhY3R1YWwgbGV2ZWxzIGFycmF5LiBTaW5jZSB0aGVyZSBhcmUgb25seSB0aHJlZVxuICAgICAgLy8gbGV2ZWxzICgwLCAxLCAyKSBpbiBhbiBpbXBsZW1lbnRhdGlvbiB0aGF0IGRvZXNuJ3QgdGFrZVxuICAgICAgLy8gZXhwbGljaXQgZW1iZWRkaW5nIGludG8gYWNjb3VudCwgd2UgY2FuIGJ1aWxkIHVwIHRoZSBvcmRlciBvblxuICAgICAgLy8gdGhlIGZseSwgd2l0aG91dCBmb2xsb3dpbmcgdGhlIGxldmVsLWJhc2VkIGFsZ29yaXRobS5cbiAgICAgIHZhciBvcmRlciA9IFtdLCBtO1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW47KSB7XG4gICAgICAgIGlmIChjb3VudHNBc0xlZnQudGVzdCh0eXBlc1tpXSkpIHtcbiAgICAgICAgICB2YXIgc3RhcnQgPSBpO1xuICAgICAgICAgIGZvciAoKytpOyBpIDwgbGVuICYmIGNvdW50c0FzTGVmdC50ZXN0KHR5cGVzW2ldKTsgKytpKSB7fVxuICAgICAgICAgIG9yZGVyLnB1c2goe2Zyb206IHN0YXJ0LCB0bzogaSwgbGV2ZWw6IDB9KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB2YXIgcG9zID0gaSwgYXQgPSBvcmRlci5sZW5ndGg7XG4gICAgICAgICAgZm9yICgrK2k7IGkgPCBsZW4gJiYgdHlwZXNbaV0gIT0gXCJMXCI7ICsraSkge31cbiAgICAgICAgICBmb3IgKHZhciBqID0gcG9zOyBqIDwgaTspIHtcbiAgICAgICAgICAgIGlmIChjb3VudHNBc051bS50ZXN0KHR5cGVzW2pdKSkge1xuICAgICAgICAgICAgICBpZiAocG9zIDwgaikgb3JkZXIuc3BsaWNlKGF0LCAwLCB7ZnJvbTogcG9zLCB0bzogaiwgbGV2ZWw6IDF9KTtcbiAgICAgICAgICAgICAgdmFyIG5zdGFydCA9IGo7XG4gICAgICAgICAgICAgIGZvciAoKytqOyBqIDwgaSAmJiBjb3VudHNBc051bS50ZXN0KHR5cGVzW2pdKTsgKytqKSB7fVxuICAgICAgICAgICAgICBvcmRlci5zcGxpY2UoYXQsIDAsIHtmcm9tOiBuc3RhcnQsIHRvOiBqLCBsZXZlbDogMn0pO1xuICAgICAgICAgICAgICBwb3MgPSBqO1xuICAgICAgICAgICAgfSBlbHNlICsrajtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHBvcyA8IGkpIG9yZGVyLnNwbGljZShhdCwgMCwge2Zyb206IHBvcywgdG86IGksIGxldmVsOiAxfSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChvcmRlclswXS5sZXZlbCA9PSAxICYmIChtID0gc3RyLm1hdGNoKC9eXFxzKy8pKSkge1xuICAgICAgICBvcmRlclswXS5mcm9tID0gbVswXS5sZW5ndGg7XG4gICAgICAgIG9yZGVyLnVuc2hpZnQoe2Zyb206IDAsIHRvOiBtWzBdLmxlbmd0aCwgbGV2ZWw6IDB9KTtcbiAgICAgIH1cbiAgICAgIGlmIChsc3Qob3JkZXIpLmxldmVsID09IDEgJiYgKG0gPSBzdHIubWF0Y2goL1xccyskLykpKSB7XG4gICAgICAgIGxzdChvcmRlcikudG8gLT0gbVswXS5sZW5ndGg7XG4gICAgICAgIG9yZGVyLnB1c2goe2Zyb206IGxlbiAtIG1bMF0ubGVuZ3RoLCB0bzogbGVuLCBsZXZlbDogMH0pO1xuICAgICAgfVxuICAgICAgaWYgKG9yZGVyWzBdLmxldmVsICE9IGxzdChvcmRlcikubGV2ZWwpXG4gICAgICAgIG9yZGVyLnB1c2goe2Zyb206IGxlbiwgdG86IGxlbiwgbGV2ZWw6IG9yZGVyWzBdLmxldmVsfSk7XG5cbiAgICAgIHJldHVybiBvcmRlcjtcbiAgICB9O1xuICB9KSgpO1xuXG4gIC8vIFRIRSBFTkRcblxuICBDb2RlTWlycm9yLnZlcnNpb24gPSBcIjMuMjIuMFwiO1xuXG4gIHJldHVybiBDb2RlTWlycm9yO1xufSkoKTtcbiIsInZhciBDb2RlTWlycm9yID0gcmVxdWlyZSgnY29kZS1taXJyb3InKTtcblxuLy8gTUFHSUMhXG5mdW5jdGlvbiB0cmltSW5pdGlhbFRhYnMoc3RyKSB7XG4gIHZhciB0YWJzUmUgPSAvKFxcdCopLztcbiAgdmFyIHRhYnNNYXRjaGVzID0gdGFic1JlLmV4ZWMoc3RyKTtcbiAgdmFyIG51bUluaXRpYWxUYWJzID0gMDtcbiAgaWYodGFic01hdGNoZXMgJiYgdGFic01hdGNoZXNbMV0pIHtcbiAgICBudW1Jbml0aWFsVGFicyA9IHRhYnNNYXRjaGVzWzFdLmxlbmd0aDtcbiAgfVxuICB2YXIgcmVwbGFjZW1lbnRSZSA9IG5ldyBSZWdFeHAoJ15cXHR7JyArIG51bUluaXRpYWxUYWJzICsgJ30nKTtcbiAgdmFyIGxpbmVzID0gc3RyLnNwbGl0KCdcXG4nKS5tYXAoZnVuY3Rpb24obGluZSkge1xuICAgIHJldHVybiBsaW5lLnJlcGxhY2UocmVwbGFjZW1lbnRSZSwgJycpO1xuICB9KTtcbiAgcmV0dXJuIGxpbmVzLmpvaW4oJ1xcbicpO1xufVxuXG52YXIgZXhlY3V0ZSA9IChmdW5jdGlvbiBtYWtlRXZhbCgpIHtcbiAgdmFyIGNoZWF0eUV2YWwgPSBldmFsO1xuICByZXR1cm4gZnVuY3Rpb24gKHN0cikge1xuICAgIGNoZWF0eUV2YWwoc3RyKTtcbiAgfTtcbn0pKCk7XG5cblxudmFyIHByb3RvID0gT2JqZWN0LmNyZWF0ZShIVE1MRWxlbWVudC5wcm90b3R5cGUpO1xuXG5wcm90by5jcmVhdGVkQ2FsbGJhY2sgPSBmdW5jdGlvbigpIHtcbiAgdGhpcy5jbSA9IG51bGw7XG5cbiAgdGhpcy5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgZnVuY3Rpb24oZSkge1xuICAgIGlmKGUubWV0YUtleSAmJiAoZS5rZXkgPT09ICdlJyB8fCBlLmtleUNvZGUgPT09IDY5KSkge1xuICAgICAgdGhpcy5ydW5Db2RlKCk7XG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgfVxuICB9LCBmYWxzZSk7XG59O1xuXG5cbnByb3RvLmF0dGFjaGVkQ2FsbGJhY2sgPSBmdW5jdGlvbigpIHtcbiAgdmFyIGNvZGVTcmM7XG4gIFxuICBpZih0aGlzLmF0dHJpYnV0ZXMuc3JjKSB7XG4gICAgY29kZVNyYyA9IHRoaXMuYXR0cmlidXRlcy5zcmMudmFsdWU7XG4gIH1cbiAgXG4gIGlmKGNvZGVTcmMgPT09IHVuZGVmaW5lZCkge1xuICAgIHRoaXMub25Db2RlTG9hZGVkKCcvLyBObyBzcmMgc3BlY2lmaWVkJyk7XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5sb2FkQ29kZShjb2RlU3JjKTtcbiAgfVxuXG59O1xuXG5cbnByb3RvLmxvYWRDb2RlID0gZnVuY3Rpb24odXJsKSB7XG4gIHZhciByZXF1ZXN0ID0gbmV3IFhNTEh0dHBSZXF1ZXN0KCk7XG4gIHZhciB0aGF0ID0gdGhpcztcbiAgcmVxdWVzdC5vcGVuKCdnZXQnLCB1cmwsIHRydWUpO1xuICByZXF1ZXN0LnJlc3BvbnNlVHlwZSA9ICd0ZXh0JztcbiAgcmVxdWVzdC5vbmxvYWQgPSBmdW5jdGlvbigpIHtcbiAgICB0aGF0Lm9uQ29kZUxvYWRlZChyZXF1ZXN0LnJlc3BvbnNlKTtcbiAgfTtcbiAgcmVxdWVzdC5vbmVycm9yID0gZnVuY3Rpb24oKSB7XG4gICAgdGhhdC5vbkNvZGVMb2FkZWQoJy8vIEVSUk9SIGxvYWRpbmcgJyArIHVybCk7XG4gIH07XG4gIHJlcXVlc3Quc2VuZCgpO1xufTtcblxuXG5wcm90by5vbkNvZGVMb2FkZWQgPSBmdW5jdGlvbihjb2RlKSB7XG4gIHZhciB0aGF0ID0gdGhpcztcbiAgdmFyIHRhID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndGV4dGFyZWEnKTtcbiAgdGhpcy5pbm5lckhUTUwgPSAnJztcbiAgdGhpcy5hcHBlbmRDaGlsZCh0YSk7XG4gIFxuICB2YXIgY29kZVZhbHVlID0gdHJpbUluaXRpYWxUYWJzKGNvZGUpLnRyaW1SaWdodCgpO1xuICB2YXIgY20gPSBDb2RlTWlycm9yKGZ1bmN0aW9uKGVsKSB7XG4gICAgICB0aGF0LnJlcGxhY2VDaGlsZChlbCwgdGEpO1xuICAgIH0sIHtcbiAgICAgIHZhbHVlOiBjb2RlVmFsdWUsXG4gICAgICAvKmxpbmVXcmFwcGluZzogdHJ1ZSxcbiAgICAgIGxpbmVOdW1iZXJzOiB0cnVlLFxuICAgICAgc3R5bGVBY3RpdmVMaW5lOiB0cnVlLFxuICAgICAgbWF0Y2hCcmFja2V0czogdHJ1ZSxcbiAgICAgIHNob3dUcmFpbGluZ1NwYWNlOiB0cnVlLCovXG4gICAgfVxuICApO1xuICB0aGlzLmNtID0gY207XG5cbiAgdmFyIGV2dCA9IGRvY3VtZW50LmNyZWF0ZUV2ZW50KCdDdXN0b21FdmVudCcpO1xuICBldnQuaW5pdEN1c3RvbUV2ZW50KCdsb2FkZWQnLCBmYWxzZSwgZmFsc2UsIHt9KTtcbiAgdGhpcy5kaXNwYXRjaEV2ZW50KGV2dCk7XG5cbn07XG5cblxucHJvdG8ucnVuQ29kZSA9IGZ1bmN0aW9uKCkge1xuXG4gIGlmKCF0aGlzLmNtKSB7XG4gICAgY29uc29sZS5sb2coJ25vdGhpbmcgdG8gcnVuIScpO1xuICAgIHJldHVybjtcbiAgfVxuICB2YXIgY29kZSA9IHRoaXMuY20uZ2V0U2VsZWN0aW9uKCkudHJpbSgpO1xuXG4gIC8vIEFoLCBidXQgbm90aGluZydzIHNlbGVjdGVkLCBzbyB3ZSdsbCBmaW5kIHdoZXJlIHRoZSBjdXJzb3IgaXNcbiAgLy8gYW5kIGV4ZWN1dGUgdGhhdCBsaW5lIG9ubHlcbiAgaWYoY29kZS5sZW5ndGggPT09IDApIHtcbiAgICB2YXIgY3Vyc29yID0gdGhpcy5jbS5nZXRDdXJzb3IoKTtcbiAgICBjb2RlID0gdGhpcy5jbS5nZXRMaW5lKGN1cnNvci5saW5lKTtcbiAgfVxuXG4gIGV4ZWN1dGUoY29kZSk7XG5cbn07XG5cbnByb3RvLnJ1bkFsbENvZGUgPSBmdW5jdGlvbigpIHtcbiAgdmFyIGNvZGUgPSB0aGlzLmNtLmdldFZhbHVlKCk7XG4gIGV4ZWN1dGUoY29kZSk7XG59O1xuXG5cbmZ1bmN0aW9uIFhFZGl0b3IoZWxlbWVudE5hbWUpIHtcblxuICBkb2N1bWVudC5yZWdpc3RlckVsZW1lbnQoZWxlbWVudE5hbWUsIHtcblx0XHRwcm90b3R5cGU6IHByb3RvXG5cdH0pO1xuXG59XG5cbm1vZHVsZS5leHBvcnRzID0gWEVkaXRvcjtcblxuIiwidmFyIGVsZW1lbnQgPSByZXF1aXJlKCcuL2VsZW1lbnQuanMnKTtcbmVsZW1lbnQoJ3gtZWRpdG9yJyk7XG4iXX0=
