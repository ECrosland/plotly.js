/**
* Copyright 2012-2019, Plotly, Inc.
* All rights reserved.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/

'use strict';

var d3 = require('d3');

var hasTransition = require('../sunburst/helpers').hasTransition;
var helpers = require('../sunburst/helpers');

var Lib = require('../../lib');
var TEXTPAD = require('../bar/constants').TEXTPAD;
var toMoveInsideBar = require('../bar/plot').toMoveInsideBar;

var drawDescendants = require('./draw_descendants');
var drawAncestors = require('./draw_ancestors');

module.exports = function(gd, cdmodule, transitionOpts, makeOnCompleteCallback) {
    var fullLayout = gd._fullLayout;
    var layer = fullLayout._treemaplayer;
    var join, onComplete;

    // If transition config is provided, then it is only a partial replot and traces not
    // updated are removed.
    var isFullReplot = !transitionOpts;

    join = layer.selectAll('g.trace.treemap')
        .data(cdmodule, function(cd) { return cd[0].trace.uid; });

    join.enter().append('g')
        .classed('trace', true)
        .classed('treemap', true);

    join.order();

    if(hasTransition(transitionOpts)) {
        if(makeOnCompleteCallback) {
            // If it was passed a callback to register completion, make a callback. If
            // this is created, then it must be executed on completion, otherwise the
            // pos-transition redraw will not execute:
            onComplete = makeOnCompleteCallback();
        }

        var transition = d3.transition()
            .duration(transitionOpts.duration)
            .ease(transitionOpts.easing)
            .each('end', function() { onComplete && onComplete(); })
            .each('interrupt', function() { onComplete && onComplete(); });

        transition.each(function() {
            // Must run the selection again since otherwise enters/updates get grouped together
            // and these get executed out of order. Except we need them in order!
            layer.selectAll('g.trace').each(function(cd) {
                plotOne(gd, cd, this, transitionOpts);
            });
        });
    } else {
        join.each(function(cd) {
            plotOne(gd, cd, this, transitionOpts);
        });
    }

    if(isFullReplot) {
        join.exit().remove();
    }
};

function plotOne(gd, cd, element, transitionOpts) {
    var fullLayout = gd._fullLayout;
    var cd0 = cd[0];
    var trace = cd0.trace;
    var hierarchy = cd0.hierarchy;
    var hasTransition = helpers.hasTransition(transitionOpts);

    var entry = helpers.findEntryWithLevel(hierarchy, trace.level);
    var maxDepth = helpers.getMaxDepth(trace);
    var hasVisibleDepth = function(pt) {
        return pt.data.depth - entry.data.depth < maxDepth;
    };

    var gs = fullLayout._size;
    var domain = trace.domain;

    var vpw = gs.w * (domain.x[1] - domain.x[0]);
    var vph = gs.h * (domain.y[1] - domain.y[0]);
    var barW = vpw;
    var barH = trace.pathbar.thickness;
    var barPad = trace.marker.line.width + 1; // TODO: may expose this constant in future
    var barDifY = !trace.pathbar.visible ? 0 :
        trace.pathbar.side.indexOf('bottom') > -1 ? vph + barPad : -(barH + barPad);

    var pathbarOrigin = {
        x0: barW, // slide to the right
        x1: barW,
        y0: barDifY,
        y1: barDifY + barH
    };

    var findClosestEdge = function(pt, ref, size) {
        var e = trace.tiling.pad;
        var isLeftOfRect = function(x) { return x - e <= ref.x0; };
        var isRightOfRect = function(x) { return x + e >= ref.x1; };
        var isBottomOfRect = function(y) { return y - e <= ref.y0; };
        var isTopOfRect = function(y) { return y + e >= ref.y1; };

        return {
            x0: isLeftOfRect(pt.x0 - e) ? 0 : isRightOfRect(pt.x0 - e) ? size[0] : pt.x0,
            x1: isLeftOfRect(pt.x1 + e) ? 0 : isRightOfRect(pt.x1 + e) ? size[0] : pt.x1,
            y0: isBottomOfRect(pt.y0 - e) ? 0 : isTopOfRect(pt.y0 - e) ? size[1] : pt.y0,
            y1: isBottomOfRect(pt.y1 + e) ? 0 : isTopOfRect(pt.y1 + e) ? size[1] : pt.y1
        };
    };

    // stash of 'previous' position data used by tweening functions
    var prevEntry = null;
    var prevLookup = {};
    var prevLookdown = {};
    var nextOfPrevEntry = null;
    var getPrev = function(pt, upDown) {
        return upDown ?
            prevLookup[helpers.getPtId(pt)] :
            prevLookdown[helpers.getPtId(pt)];
    };

    var getOrigin = function(pt, upDown, refRect, size) {
        if(upDown) {
            return prevLookup[helpers.getPtId(hierarchy)] || pathbarOrigin;
        } else {
            var ref = prevLookdown[trace.level] || refRect;

            if(hasVisibleDepth(pt)) { // case of an empty object - happens when maxdepth is set
                return findClosestEdge(pt, ref, size);
            }
        }
        return {};
    };

    var pad = trace.marker.pad;
    // N.B. handle multiple-root special case
    if(cd0.hasMultipleRoots && helpers.isHierarchyRoot(entry)) {
        maxDepth++; // increase maxDepth by one
    }
    trace._maxDepth = maxDepth;

    var cenX = -vpw / 2 + gs.l + gs.w * (domain.x[1] + domain.x[0]) / 2;
    var cenY = -vph / 2 + gs.t + gs.h * (1 - (domain.y[1] + domain.y[0]) / 2);

    var viewMapX = function(x) { return cenX + x; };
    var viewMapY = function(y) { return cenY + y; };

    var barY0 = viewMapY(0);
    var barX0 = viewMapX(0);

    var viewBarX = function(x) { return barX0 + x; };
    var viewBarY = function(y) { return barY0 + y; };

    function pos(x, y) {
        return x + ',' + y;
    }

    function noNaN(path) {
        return path.indexOf('NaN') > -1 ? '' : path;
    }

    var xStart = viewBarX(0);
    var limitX0 = function(p) {
        p.x = Math.max(xStart, p.x);
    };

    var divider = trace.pathbar.divider;
    var hasExtraPoint = (divider !== '|');

    // pathbar(directory) path generation fn
    var pathAncestor = function(d) {
        var _x0 = viewBarX(Math.max(Math.min(d.x0, d.x0), 0));
        var _x1 = viewBarX(Math.min(Math.max(d.x1, d.x1), barW));
        var _y0 = viewBarY(d.y0);
        var _y1 = viewBarY(d.y1);

        var halfH = barH / 2;

        var pM = {};
        var midLeft;
        if(hasExtraPoint) {
            midLeft = true;
            pM.x = _x0;

            pM.y = (
                divider === '>' ||
                divider === '<'
            ) ? _y0 + halfH : _y0;
        }

        var pA = {x: _x0, y: _y0};
        var pB = {x: _x1, y: _y0};
        var pC = {x: _x1, y: _y1};
        var pD = {x: _x0, y: _y1};

        if(divider === '>') {
            pA.x -= halfH;
            pD.x -= halfH;
        } else if(divider === '/') {
            pD.x -= halfH;
        } else if(divider === '\\') {
            pM.x -= halfH;
        } else if(divider === '<') {
            pM.x -= halfH;
        }

        limitX0(pA);
        limitX0(pD);
        limitX0(pM);

        return noNaN(
           'M' + pos(pA.x, pA.y) +
           'L' + pos(pB.x, pB.y) +
           'L' + pos(pC.x, pC.y) +
           'L' + pos(pD.x, pD.y) +
           (midLeft ? 'L' + pos(pM.x, pM.y) : '') +
           'Z'
        );
    };

    // slice path generation fn
    var pathDescendant = function(d) {
        var _x0 = viewMapX(d.x0);
        var _x1 = viewMapX(d.x1);
        var _y0 = viewMapY(d.y0);
        var _y1 = viewMapY(d.y1);

        var dx = _x1 - _x0;
        var dy = _y1 - _y0;
        if(!dx || !dy) return '';

        var FILLET = 0; // TODO: may expose this constant

        var r = (
            dx > 2 * FILLET &&
            dy > 2 * FILLET
        ) ? FILLET : 0;

        var arc = function(rx, ry) { return r ? 'a' + pos(r, r) + ' 0 0 1 ' + pos(rx, ry) : ''; };

        return noNaN(
           'M' + pos(_x0, _y0 + r) +
           arc(r, -r) +
           'L' + pos(_x1 - r, _y0) +
           arc(r, r) +
           'L' + pos(_x1, _y1 - r) +
           arc(-r, r) +
           'L' + pos(_x0 + r, _y1) +
           arc(-r, -r) + 'Z'
        );
    };

    var toMoveInsideSlice = function(x0, x1, y0, y1, textBB, opts) {
        var hasFlag = function(f) { return trace.textposition.indexOf(f) !== -1; };

        var hasBottom = hasFlag('bottom');
        var hasTop = hasFlag('top') || (opts.isHeader && !hasBottom);

        var anchor =
            hasTop ? 'start' :
            hasBottom ? 'end' : 'middle';

        var hasRight = hasFlag('right');
        var hasLeft = hasFlag('left') || opts.isMenu;

        var offsetDir =
            hasLeft ? 'left' :
            hasRight ? 'right' : 'center';

        if(opts.isMenu || !opts.isHeader) {
            x0 += hasLeft ? TEXTPAD : 0;
            x1 -= hasRight ? TEXTPAD : 0;
        }

        if(opts.isHeader) {
            x0 += pad.l - TEXTPAD;
            x1 -= pad.r - TEXTPAD;

            // limit the drawing area for headers
            var limY;
            if(hasBottom) {
                limY = y1 - pad.b;
                if(y0 < limY && limY < y1) y0 = limY;
            } else {
                limY = y0 + pad.t;
                if(y0 < limY && limY < y1) y1 = limY;
            }
        }

        // position the text relative to the slice
        var transform = toMoveInsideBar(x0, x1, y0, y1, textBB, {
            isHorizontal: false,
            constrained: true,
            angle: 0,
            anchor: anchor
        });

        if(offsetDir !== 'center') {
            var deltaX = (x1 - x0) / 2 - transform.scale * (textBB.right - textBB.left) / 2;
            if(opts.isHeader) deltaX -= TEXTPAD;

            if(offsetDir === 'left') transform.targetX -= deltaX;
            else if(offsetDir === 'right') transform.targetX += deltaX;
        }

        transform.targetX = viewMapX(transform.targetX);
        transform.targetY = viewMapY(transform.targetY);

        if(isNaN(transform.targetX) || isNaN(transform.targetY)) {
            return {};
        }

        return {
            scale: transform.scale,
            rotate: transform.rotate,
            textX: transform.textX,
            textY: transform.textY,
            targetX: transform.targetX,
            targetY: transform.targetY
        };
    };

    var interpFromParent = function(pt, upDown) {
        var parentPrev;
        var i = 0;
        var Q = pt;
        while(!parentPrev && i < maxDepth) { // loop to find a parent/grandParent on the previous graph
            i++;
            Q = Q.parent;
            if(Q) {
                parentPrev = getPrev(Q, upDown);
            } else i = maxDepth;
        }
        return parentPrev || {};
    };

    var makeExitSliceInterpolator = function(pt, upDown, refRect, size) {
        var prev = getPrev(pt, upDown);
        var next;

        if(upDown) {
            next = pathbarOrigin;
        } else {
            var entryPrev = getPrev(entry, upDown);
            if(entryPrev) {
                // 'entryPrev' is here has the previous coordinates of the entry
                // node, which corresponds to the last "clicked" node when zooming in
                next = findClosestEdge(pt, entryPrev, size);
            } else {
                // this happens when maxdepth is set, when leaves must
                // be removed and the entry is new (i.e. does not have a 'prev' object)
                next = {};
            }
        }

        return d3.interpolate(prev, next);
    };

    var makeUpdateSliceInterpolator = function(pt, upDown, refRect, size) {
        var prev0 = getPrev(pt, upDown);
        var prev;

        if(prev0) {
            // if pt already on graph, this is easy
            prev = prev0;
        } else {
            // for new pts:
            if(upDown) {
                prev = pathbarOrigin;
                if(helpers.isEntry(pt)) prev.x0 = 0;
            } else {
                if(prevEntry) {
                    // if trace was visible before
                    if(pt.parent) {
                        var ref = nextOfPrevEntry || refRect;

                        if(ref && !upDown) {
                            prev = findClosestEdge(pt, ref, size);
                        } else {
                            // if new leaf (when maxdepth is set),
                            // grow it from its parent node
                            prev = {};
                            Lib.extendFlat(prev, interpFromParent(pt, upDown));
                        }
                    } else {
                        prev = pt;
                    }
                } else {
                    prev = {};
                }
            }
        }

        return d3.interpolate(prev, {
            x0: pt.x0,
            x1: pt.x1,
            y0: pt.y0,
            y1: pt.y1
        });
    };

    var makeUpdateTextInterpolator = function(pt, upDown, refRect, size) {
        var prev0 = getPrev(pt, upDown);
        var prev = {};
        var origin = getOrigin(pt, upDown, refRect, size);

        Lib.extendFlat(prev, {
            transform: toMoveInsideSlice(
                origin.x0,
                origin.x1,
                origin.y0,
                origin.y1,
                pt.textBB,
                {
                    isHeader: helpers.isHeader(pt, trace)
                }
            )
        });

        if(prev0) {
            // if pt already on graph, this is easy
            prev = prev0;
        } else {
            // for new pts:
            if(upDown) {
                prev = pt;
            } else {
                if(pt.parent) {
                    Lib.extendFlat(prev, interpFromParent(pt, upDown));
                }
            }
        }

        return d3.interpolate(prev, {
            transform: {
                scale: pt.transform.scale,
                rotate: pt.transform.rotate,
                textX: pt.transform.textX,
                textY: pt.transform.textY,
                targetX: pt.transform.targetX,
                targetY: pt.transform.targetY
            }
        });
    };

    var handleSlicesExit = function(slices, upDown, refRect, size, pathSlice) {
        var width = size[0];
        var height = size[1];

        if(hasTransition) {
            slices.exit().transition()
                .each(function() {
                    var sliceTop = d3.select(this);

                    var slicePath = sliceTop.select('path.surface');
                    slicePath.transition().attrTween('d', function(pt2) {
                        var interp = makeExitSliceInterpolator(pt2, upDown, refRect, [width, height]);
                        return function(t) { return pathSlice(interp(t)); };
                    });

                    var sliceTextGroup = sliceTop.select('g.slicetext');
                    sliceTextGroup.attr('opacity', 0);
                })
                .remove();
        } else {
            slices.exit().remove();
        }
    };

    var strTransform = function(d) {
        return Lib.getTextTransform({
            textX: d.transform.textX,
            textY: d.transform.textY,
            targetX: d.transform.targetX,
            targetY: d.transform.targetY,
            scale: d.transform.scale,
            rotate: d.transform.rotate
        });
    };

    var gTrace = d3.select(element);
    var selAncestors = gTrace.selectAll('g.pathbar');
    var selDescendants = gTrace.selectAll('g.slice');

    if(!entry) {
        return selDescendants.remove() && selAncestors.remove();
    }

    if(hasTransition) {
        // Important: do this before binding new sliceData!

        selAncestors.each(function(pt) {
            prevLookup[helpers.getPtId(pt)] = {
                x0: pt.x0,
                x1: pt.x1,
                y0: pt.y0,
                y1: pt.y1,
                transform: pt.transform
            };
        });

        selDescendants.each(function(pt) {
            prevLookdown[helpers.getPtId(pt)] = {
                x0: pt.x0,
                x1: pt.x1,
                y0: pt.y0,
                y1: pt.y1,
                transform: pt.transform
            };

            if(!prevEntry && helpers.isEntry(pt)) {
                prevEntry = pt;
            }
        });
    }

    nextOfPrevEntry = drawDescendants(gd, cd, entry, selDescendants, {
        width: vpw,
        height: vph,

        viewX: viewMapX,
        viewY: viewMapY,

        pathSlice: pathDescendant,
        toMoveInsideSlice: toMoveInsideSlice,

        prevEntry: prevEntry,
        makeUpdateSliceInterpolator: makeUpdateSliceInterpolator,
        makeUpdateTextInterpolator: makeUpdateTextInterpolator,

        handleSlicesExit: handleSlicesExit,
        hasTransition: hasTransition,
        strTransform: strTransform
    });

    if(trace.pathbar.visible) {
        drawAncestors(gd, cd, entry, selAncestors, {
            barDifY: barDifY,
            width: barW,
            height: barH,

            viewX: viewBarX,
            viewY: viewBarY,

            pathSlice: pathAncestor,
            toMoveInsideSlice: toMoveInsideSlice,

            makeUpdateSliceInterpolator: makeUpdateSliceInterpolator,
            makeUpdateTextInterpolator: makeUpdateTextInterpolator,

            handleSlicesExit: handleSlicesExit,
            hasTransition: hasTransition,
            strTransform: strTransform
        });
    }
}
