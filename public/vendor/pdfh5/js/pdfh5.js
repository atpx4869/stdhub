; (function (g, fn) {
	var version = "3.0.0",
		pdfjsVersion = "5.4.296";
	console.info("pdfh5.js v" + version + " && pdf.js v" + pdfjsVersion + " https://pdfh5.gjtool.cn");
	if (!g.document) {
		throw new Error("pdfh5 requires a window with a document");
	}

	async function initPdfJs() {
		if (g.pdfjsLib) {
			return g.pdfjsLib;
		}
		try {
			let pdfjsLib = await import('./pdf.min.js');
			let sandboxModule = await import('./pdf.sandbox.min.js');
			let workerSrc = './js/pdf.worker.min.js';
			let cMapUrl = '../cmaps/';
			let standardFontDataUrl = '../standard_fonts/';
			let iccUrl = '../iccs/';
			let wasmUrl = '../wasm/';
			// 集成沙箱功能
			if (sandboxModule && sandboxModule.default) {
				pdfjsLib.Sandbox = sandboxModule.default;
				pdfjsLib.SandboxManager = sandboxModule.SandboxManager;
			}

			pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

			var resourcePaths = {
				workerSrc: workerSrc,
				cMapUrl: cMapUrl,
				standardFontDataUrl: standardFontDataUrl,
				iccUrl: iccUrl,
				wasmUrl: wasmUrl
			};

			window._pdfh5ResourcePaths = resourcePaths;

			return pdfjsLib;
		} catch (error) {
			console.error('Failed to load PDF.js:', error);
			throw error;
		}
	}

	// 创建Pdfh5构造函数
	var Pdfh5Constructor = fn(version, initPdfJs);

	if (typeof define === 'function' && define.amd) {
		define(function () {
			return Pdfh5Constructor;
		});
	} else if (typeof module !== 'undefined' && module.exports) {
		module.exports = Pdfh5Constructor;
	} else {
		g.Pdfh5 = Pdfh5Constructor;
	}
})(typeof window !== 'undefined' ? window : this, function (version, initPdfJs) {
	'use strict';

	var css = '.pdfjs {width: 100%;height: 100%;overflow: hidden;background: #fff;position: relative;}.pdfjs .viewerContainer {position: relative;width: 100%;height: 100%;overflow-y: auto;overflow-x: hidden;-webkit-overflow-scrolling: touch;transition: all .3s;}.pdfjs .pdfViewer {position: relative;top: 0;left: 0;padding: 10px 8px;}.pdfjs .pdfViewer .pageContainer {margin: 0px auto 8px auto;position: relative;overflow: visible;-webkit-box-shadow: darkgrey 0px 1px 3px 0px;-moz-box-shadow: darkgrey 0px 1px 3px 0px;box-shadow: darkgrey 0px 1px 3px 0px;background-color: white;box-sizing: border-box;}.pdfjs .pdfViewer .pageContainer img {width: 100%;height: 100%;position: relative;z-index: 100;user-select: none;pointer-events: none;}.pdfjs .pdfViewer .pageContainer canvas {width: 100%;height: 100%;position: relative;z-index: 100;user-select: none;pointer-events: none;}.pdfjs .pageNum {padding: 0px 7px;height: 26px;position: absolute;top: 20px;left: 15px;z-index: 997;border-radius: 8px;transition: all .3s;display: none;}.pdfjs .pageNum-bg, .pdfjs .pageNum-num {width: 100%;height: 100%;line-height: 26px;text-align: center;position: absolute;top: 0px;left: 0px;color: #fff;border-radius: 8px;font-size: 16px;}.pdfjs .pageNum-bg {background: rgba(0, 0, 0, 0.5);}.pdfjs .pageNum-num {position: relative;}.pdfjs .pageNum span {color: #fff;font-size: 16px;}.pdfjs .loadingBar {position: absolute;width: 100%;z-index: 1000;background: #fff !important;height: 4px;top: 0px;left: 0px;transition: all .3s;}.pdfjs .loadingBar .progress {background: #fff !important;position: absolute;top: 0;left: 0;width: 0%;height: 100%;overflow: hidden;transition: width 200ms;}.pdfjs .loadingBar .progress .glimmer {position: absolute;top: 0;left: 0;height: 100%;width: calc(100% + 150px);background: #7bcf34;}.pdfjs .backTop {width: 50px;height: 50px;line-height: 50px;text-align: center;position: absolute;bottom: 90px;right: 15px;font-size: 18px;z-index: 999;border-radius: 50%;background: rgba(0, 0, 0, 0.4) url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAABmJLR0QAAAAAAAD5Q7t/AAAACXBIWXMAAAsSAAALEgHS3X78AAAA+klEQVRYw+2WUQ2DMBCG2TIBSJiESkACEpCAg83BcLBJmIQ5gClgDpiDby9tciGkoaUtZOESXuhdv7+X/pdm2dYC6IgX7Zh3THy+w9oN/rMASqBcE26iSA1XwCAEDIBKBc8F/KE/gB7IU8BbDXyJf2Z2tFFFAE8N6iRIi/jotXssuGn1FzhPrCu9BtCEhlcCrix5hbiYVSh46bKpELvcniO71Q51zWJ7ju3mUe9vzym7eR7Az57CbohTXBzAt9GknG9PoLY8KK4z6htLfeXTTXMZAfoZuWYWKC+YZWMAQuWZSP0k2wXsAnYB2xNwci1wGTKhO/COlLtu/ABVfTFsxwwYRgAAAABJRU5ErkJggg==) no-repeat center;background-size: 50% 50%;transition: all .3s;display: none;}.pdfjs .loadEffect {width: 100px;height: 100px;position: absolute;top: 50%;left: 50%;margin-top: -50px;margin-left: -50px;z-index: 103;background: url(data:image/gif;base64,R0lGODlhgACAAKIAAP///93d3bu7u5mZmQAA/wAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFBQAEACwCAAIAfAB8AAAD/0i63P4wygYqmDjrzbtflvWNZGliYXiubKuloivPLlzReD7al+7/Eh5wSFQIi8hHYBkwHUmD6CD5YTJLz49USuVYraRsZ7vtar7XnQ1Kjpoz6LRHvGlz35O4nEPP2O94EnpNc2sef1OBGIOFMId/inB6jSmPdpGScR19EoiYmZobnBCIiZ95k6KGGp6ni4wvqxilrqBfqo6skLW2YBmjDa28r6Eosp27w8Rov8ekycqoqUHODrTRvXsQwArC2NLF29UM19/LtxO5yJd4Au4CK7DUNxPebG4e7+8n8iv2WmQ66BtoYpo/dvfacBjIkITBE9DGlMvAsOIIZjIUAixliv9ixYZVtLUos5GjwI8gzc3iCGghypQqrbFsme8lwZgLZtIcYfNmTJ34WPTUZw5oRxdD9w0z6iOpO15MgTh1BTTJUKos39jE+o/KS64IFVmsFfYT0aU7capdy7at27dw48qdS7eu3bt480I02vUbX2F/JxYNDImw4GiGE/P9qbhxVpWOI/eFKtlNZbWXuzlmG1mv58+gQ4seTbq06dOoU6vGQZJy0FNlMcV+czhQ7SQmYd8eMhPs5BxVdfcGEtV3buDBXQ+fURxx8oM6MT9P+Fh6dOrH2zavc13u9JXVJb520Vp8dvC76wXMuN5Sepm/1WtkEZHDefnzR9Qvsd9+/wi8+en3X0ntYVcSdAE+UN4zs7ln24CaLagghIxBaGF8kFGoIYV+Ybghh841GIyI5ICIFoklJsigihmimJOLEbLYIYwxSgigiZ+8l2KB+Ml4oo/w8dijjcrouCORKwIpnJIjMnkkksalNeR4fuBIm5UEYImhIlsGCeWNNJphpJdSTlkml1jWeOY6TnaRpppUctcmFW9mGSaZceYopH9zkjnjUe59iR5pdapWaGqHopboaYualqije67GJ6CuJAAAIfkEBQUABAAsCgACAFcAMAAAA/9Iutz+ML5Ag7w46z0r5WAoSp43nihXVmnrdusrv+s332dt4Tyo9yOBUJD6oQBIQGs4RBlHySSKyczVTtHoidocPUNZaZAr9F5FYbGI3PWdQWn1mi36buLKFJvojsHjLnshdhl4L4IqbxqGh4gahBJ4eY1kiX6LgDN7fBmQEJI4jhieD4yhdJ2KkZk8oiSqEaatqBekDLKztBG2CqBACq4wJRi4PZu1sA2+v8C6EJexrBAD1AOBzsLE0g/V1UvYR9sN3eR6lTLi4+TlY1wz6Qzr8u1t6FkY8vNzZTxaGfn6mAkEGFDgL4LrDDJDyE4hEIbdHB6ESE1iD4oVLfLAqPETIsOODwmCDJlv5MSGJklaS6khAQAh+QQFBQAEACwfAAIAVwAwAAAD/0i63A4QuEmrvTi3yLX/4MeNUmieITmibEuppCu3sDrfYG3jPKbHveDktxIaF8TOcZmMLI9NyBPanFKJp4A2IBx4B5lkdqvtfb8+HYpMxp3Pl1qLvXW/vWkli16/3dFxTi58ZRcChwIYf3hWBIRchoiHiotWj5AVkpIXi4xLjxiaiJR/T5ehoomcnZ+EGamqq6VGoK+pGqxCtaiiuJVBu7yaHrk4pxqwxMUzwcKbyrPMzZG90NGDrh/JH8t72dq3IN1jfCHb3L/e5ebh4ukmxyDn6O8g08jt7tf26ybz+m/W9GNXzUQ9fm1Q/APoSWAhhfkMAmpEbRhFKwsvCsmosRIHx444PoKcIXKkjIImjTzjkQAAIfkEBQUABAAsPAA8AEIAQgAAA/VIBNz+8KlJq72Yxs1d/uDVjVxogmQqnaylvkArT7A63/V47/m2/8CgcEgsGo/IpHLJbDqf0Kh0Sj0FroGqDMvVmrjgrDcTBo8v5fCZki6vCW33Oq4+0832O/at3+f7fICBdzsChgJGeoWHhkV0P4yMRG1BkYeOeECWl5hXQ5uNIAOjA1KgiKKko1CnqBmqqk+nIbCkTq20taVNs7m1vKAnurtLvb6wTMbHsUq4wrrFwSzDzcrLtknW16tI2tvERt6pv0fi48jh5h/U6Zs77EXSN/BE8jP09ZFA+PmhP/xvJgAMSGBgQINvEK5ReIZhQ3QEMTBLAAAh+QQFBQAEACwCAB8AMABXAAAD50i6DA4syklre87qTbHn4OaNYSmNqKmiqVqyrcvBsazRpH3jmC7yD98OCBF2iEXjBKmsAJsWHDQKmw571l8my+16v+CweEwum8+hgHrNbrvbtrd8znbR73MVfg838f8BeoB7doN0cYZvaIuMjY6PkJGSk2gClgJml5pjmp2YYJ6dX6GeXaShWaeoVqqlU62ir7CXqbOWrLafsrNctjIDwAMWvC7BwRWtNsbGFKc+y8fNsTrQ0dK3QtXAYtrCYd3eYN3c49/a5NVj5eLn5u3s6e7x8NDo9fbL+Mzy9/T5+tvUzdN3Zp+GBAAh+QQJBQAEACwCAAIAfAB8AAAD/0i63P4wykmrvTjrzbv/YCiOZGmeaKqubOu+cCzPdArcQK2TOL7/nl4PSMwIfcUk5YhUOh3M5nNKiOaoWCuWqt1Ou16l9RpOgsvEMdocXbOZ7nQ7DjzTaeq7zq6P5fszfIASAYUBIYKDDoaGIImKC4ySH3OQEJKYHZWWi5iZG0ecEZ6eHEOio6SfqCaqpaytrpOwJLKztCO2jLi1uoW8Ir6/wCHCxMG2x7muysukzb230M6H09bX2Nna29zd3t/g4cAC5OXm5+jn3Ons7eba7vHt2fL16tj2+QL0+vXw/e7WAUwnrqDBgwgTKlzIsKHDh2gGSBwAccHEixAvaqTYcFCjRoYeNyoM6REhyZIHT4o0qPIjy5YTTcKUmHImx5cwE85cmJPnSYckK66sSAAj0aNIkypdyrSp06dQo0qdSrWq1atYs2rdyrWr169gwxZJAAA7) no-repeat center;background-size: 30% 30%;transition: all .3s;display:block;}.pdfjs .pdfViewer .pageContainer img.pdfLogo {position: absolute;z-index: 101;}.pdfjs .pdfViewer .pageContainer canvas.pdfLogo {position: absolute;z-index: 101;}.pdfjs .textLayer {position: absolute;left: 0;top: 0;right: 0;bottom: 0;overflow: hidden;opacity: 0.2;line-height: 1.0;z-index: 101;user-select: text;}.pdfjs .textLayer>span {color: transparent;position: absolute;white-space: pre;cursor: text;transform-origin: 0% 0%;}.pdfjs .textLayer .highlight {margin: -1px;padding: 1px;background-color: rgba(180, 0, 170, 1);border-radius: 4px;}.pdfjs .textLayer .highlight.begin {border-radius: 4px 0px 0px 4px;}.pdfjs .textLayer .highlight.end {border-radius: 0px 4px 4px 0px;}.pdfjs .textLayer .highlight.middle {border-radius: 0px;}.pdfjs .textLayer .highlight.selected {background-color: rgba(0, 100, 0, 1);}.pdfjs .textLayer ::selection {background: rgba(0, 0, 255, 0.3); }.pdfjs .textLayer .endOfContent {display: block;position: absolute;left: 0px;top: 100%;right: 0px;bottom: 0px;z-index: -1;cursor: default;}.pdfjs .textLayer .endOfContent.active {top: 0px;}';

	var buildElement = function (html) {
		var div = document.createElement('div');
		div.innerHTML = html;
		return div.firstChild;
	};

	var triggerEvent = function (el, name) {
		var event = document.createEvent('HTMLEvents');
		event.initEvent(name, true, false);
		el.dispatchEvent(event);
	};



	var definePinchZoom = function () {
		var PinchZoom = function (el, options, pinchParentNode) {
			this.el = el;
			this.pinchParentNode = pinchParentNode;
			this.zoomFactor = 1;
			this.lastScale = 1;
			this.offset = {
				x: 0,
				y: 0
			};
			this.options = Object.assign({}, this.defaults, options);
			this.options.tapZoomFactor = isNaN(options.tapZoomFactor) ? 2 : options.tapZoomFactor;
			this.options.zoomOutFactor = isNaN(options.zoomOutFactor) ? 1.2 : options.zoomOutFactor;
			this.options.animationDuration = isNaN(options.animationDuration) ? 300 : options.animationDuration;
			this.options.maxZoom = isNaN(options.maxZoom) ? 4 : options.maxZoom;
			this.options.minZoom = isNaN(options.minZoom) ? 0.5 : options.minZoom;
			this.options.dampingFactor = isNaN(options.dampingFactor) ? 0.85 : options.dampingFactor;
			this.setupMarkup();
			this.bindEvents();
			this.update();
			this.enable();
			this.height = 0;
			this.load = false;
			this.direction = null;
			this.clientY = null;
			this.lastclientY = null;
			this.lastOffsets = [];
			for (var i = 0; i < 5; i++) {
				this.lastOffsets.push({ x: 0, y: 0, time: Date.now() });
			}
		},
			sum = function (a, b) {
				return a + b;
			},
			isCloseTo = function (value, expected) {
				return value > expected - 0.01 && value < expected + 0.01;
			};

		PinchZoom.prototype = {
			defaults: {
				tapZoomFactor: 2,
				zoomOutFactor: 1.2,
				animationDuration: 300,
				maxZoom: 4,
				minZoom: 0.5,
				draggableUnzoomed: true,
				lockDragAxis: false,
				use2d: true,
				zoomStartEventName: 'pz_zoomstart',
				zoomEndEventName: 'pz_zoomend',
				dragStartEventName: 'pz_dragstart',
				dragEndEventName: 'pz_dragend',
				doubleTapEventName: 'pz_doubletap'
			},
			handleDragStart: function (event) {
				triggerEvent(this.el, this.options.dragStartEventName);
				this.stopAnimation();
				this.lastDragPosition = false;
				this.hasInteraction = true;
				this.handleDrag(event);
			},
			handleDrag: function (event) {
				if (this.zoomFactor > 1.0) {
					var touch = this.getTouches(event)[0];
					this.drag(touch, this.lastDragPosition, event);
					this.offset = this.sanitizeOffset(this.offset);
					this.lastDragPosition = touch;
				}
			},
			sanitizeOffset: function (offset) {
				var containerWidth = this.getContainerX();
				var imageWidth = this.el.offsetWidth * this.zoomFactor;
				var maxX = Math.max(imageWidth - containerWidth, 0);

				var containerHeight = this.getContainerY();
				var imageHeight = this.el.offsetHeight * this.zoomFactor;
				var maxY = Math.max(imageHeight - containerHeight, 0);

				var elasticFactor = 0.5;
				var newX = offset.x;
				var newY = offset.y;

				if (newX < 0) {
					newX = newX * elasticFactor;
				} else if (newX > maxX) {
					newX = maxX + (newX - maxX) * elasticFactor;
				}

				if (newY < 0) {
					newY = newY * elasticFactor;
				} else if (newY > maxY) {
					newY = maxY + (newY - maxY) * elasticFactor;
				}

				return {
					x: newX,
					y: newY
				};
			},
			handleDragEnd: function () {
				triggerEvent(this.el, this.options.dragEndEventName);
				this.end();

				var now = Date.now();
				var validRecords = this.lastOffsets.filter(r => now - r.time < 100);
				var velocityX = validRecords.length > 1 ?
					(validRecords[validRecords.length - 1].x - validRecords[0].x) /
					(validRecords[validRecords.length - 1].time - validRecords[0].time) : 0;

				this.startInertiaAnimation(velocityX);
			},

			startInertiaAnimation: function (initialVelocity) {
				var minVelocity = 0.08;
				var decay = 0.92;

				var animateFrame = () => {
					if (Math.abs(initialVelocity) < minVelocity) return;

					this.addOffset({
						x: initialVelocity * 16,
						y: 0
					});

					this.offset = this.sanitizeOffset(this.offset);
					this.update();

					initialVelocity *= decay;
					requestAnimationFrame(animateFrame);
				};

				requestAnimationFrame(animateFrame);
			},
			handleZoomStart: function (event) {
				triggerEvent(this.el, this.options.zoomStartEventName);
				this.stopAnimation();
				this.lastScale = 1;
				this.nthZoom = 0;
				this.lastZoomCenter = false;
				this.hasInteraction = true;
			},
			handleZoom: function (event, newScale) {
				var touchCenter = this.getTouchCenter(this.getTouches(event)),
					scale = newScale / this.lastScale;
				this.lastScale = newScale;
				this.nthZoom += 1;
				if (this.nthZoom > 3) {
					this.scale(scale, touchCenter);
					this.drag(touchCenter, this.lastZoomCenter);
				}
				this.lastZoomCenter = touchCenter;
			},

			handleZoomEnd: function () {
				triggerEvent(this.el, this.options.zoomEndEventName);
				this.end();
			},
			handleDoubleTap: function (event) {
				var center = this.getTouches(event)[0],
					zoomFactor = this.zoomFactor > 1 ? 1 : this.options.tapZoomFactor,
					startZoomFactor = this.zoomFactor,
					updateProgress = (function (progress) {
						this.scaleTo(startZoomFactor + progress * (zoomFactor - startZoomFactor),
							center);
					}).bind(this);

				if (this.hasInteraction) {
					return;
				}
				if (startZoomFactor > zoomFactor) {
					center = this.getCurrentZoomCenter();
				}

				this.animate(this.options.animationDuration, updateProgress, this.swing);
				triggerEvent(this.el, this.options.doubleTapEventName);
			},
			scaleTo: function (zoomFactor, center) {
				this.scale(zoomFactor / this.zoomFactor, center);
			},
			scale: function (scale, center) {
				scale = this.scaleZoomFactor(scale);
				this.addOffset({
					x: (scale - 1) * (center.x + this.offset.x),
					y: (scale - 1) * (center.y + this.offset.y)
				});
				this.done && this.done.call(this, this.getInitialZoomFactor() * this.zoomFactor);
			},
			scaleZoomFactor: function (scale) {
				var originalZoomFactor = this.zoomFactor;
				this.zoomFactor *= scale;
				this.zoomFactor = Math.min(this.options.maxZoom, Math.max(this.zoomFactor, this.options.minZoom));
				return this.zoomFactor / originalZoomFactor;
			},
			canDrag: function () {
				return this.options.draggableUnzoomed || !isCloseTo(this.zoomFactor, 1);
			},
			drag: function (center, lastCenter, event) {
				if (!lastCenter) return;

				var dx = -(center.x - lastCenter.x) * this.options.dampingFactor;
				var dy = -(center.y - lastCenter.y) * this.options.dampingFactor;

				this.addOffset({ x: dx, y: dy });
			},
			getTouchCenter: function (touches) {
				return this.getVectorAvg(touches);
			},
			getVectorAvg: function (vectors) {
				return {
					x: vectors.map(function (v) {
						return v.x;
					}).reduce(sum) / vectors.length,
					y: vectors.map(function (v) {
						return v.y;
					}).reduce(sum) / vectors.length
				};
			},
			addOffset: function (offset) {
				this.offset = {
					x: this.offset.x + offset.x,
					y: this.offset.y + offset.y
				};
			},

			sanitize: function () {
				if (this.zoomFactor < this.options.zoomOutFactor) {
					this.zoomOutAnimation();
				} else if (this.isInsaneOffset(this.offset)) {
					this.sanitizeOffsetAnimation();
				}
			},
			isInsaneOffset: function (offset) {
				var sanitizedOffset = this.sanitizeOffset(offset);
				return sanitizedOffset.x !== offset.x ||
					sanitizedOffset.y !== offset.y;
			},
			sanitizeOffsetAnimation: function () {
				var targetOffset = this.sanitizeOffset(this.offset),
					startOffset = {
						x: this.offset.x,
						y: this.offset.y
					},
					updateProgress = (function (progress) {
						this.offset.x = startOffset.x + progress * (targetOffset.x - startOffset.x);
						this.offset.y = startOffset.y + progress * (targetOffset.y - startOffset.y);
						this.update();
					}).bind(this);

				this.animate(
					this.options.animationDuration,
					updateProgress,
					this.swing
				);
			},
			zoomOutAnimation: function () {
				var startZoomFactor = this.zoomFactor,
					zoomFactor = 1,
					center = this.getCurrentZoomCenter(),
					updateProgress = (function (progress) {
						this.scaleTo(startZoomFactor + progress * (zoomFactor - startZoomFactor),
							center);
					}).bind(this);

				this.animate(
					this.options.animationDuration,
					updateProgress,
					this.swing
				);
			},
			updateAspectRatio: function () {
				this.setContainerY(this.getContainerX() / this.getAspectRatio());
			},
			getInitialZoomFactor: function () {
				if (this.pinchContainer && this.el) {
					return this.pinchContainer.offsetWidth / this.el.offsetWidth;
				} else {
					return 0;
				}
			},
			getAspectRatio: function () {
				if (this.el) {
					return this.pinchContainer.offsetWidth / this.el.offsetHeight;
				} else {
					return 0;
				}
			},
			getCurrentZoomCenter: function () {
				var length = this.pinchContainer.offsetWidth * this.zoomFactor,
					offsetLeft = this.offset.x,
					offsetRight = length - offsetLeft - this.pinchContainer.offsetWidth,
					widthOffsetRatio = offsetLeft / offsetRight,
					centerX = widthOffsetRatio * this.pinchContainer.offsetWidth / (widthOffsetRatio + 1),

					height = this.pinchContainer.offsetHeight * this.zoomFactor,
					offsetTop = this.offset.y,
					offsetBottom = height - offsetTop - this.pinchContainer.offsetHeight,
					heightOffsetRatio = offsetTop / offsetBottom,
					centerY = heightOffsetRatio * this.pinchContainer.offsetHeight / (heightOffsetRatio + 1);

				if (offsetRight === 0) {
					centerX = this.pinchContainer.offsetWidth;
				}
				if (offsetBottom === 0) {
					centerY = this.pinchContainer.offsetHeight;
				}

				return {
					x: centerX,
					y: centerY
				};
			},

			getTouches: function (event) {
				var position = this.pinchContainer.getBoundingClientRect();
				var posTop = position.top;
				var posLeft = position.left;

				return Array.prototype.slice.call(event.touches).map(function (touch) {
					return {
						x: touch.pageX - posLeft,
						y: touch.pageY - posTop,
					};
				});
			},
			animate: function (duration, framefn, timefn, callback) {
				var startTime = new Date().getTime(),
					renderFrame = (function () {
						if (!this.inAnimation) {
							return;
						}
						var frameTime = new Date().getTime() - startTime,
							progress = frameTime / duration;
						if (frameTime >= duration) {
							framefn(1);
							if (callback) {
								callback();
							}
							this.update();
							this.stopAnimation();
						} else {
							if (timefn) {
								progress = timefn(progress);
							}
							framefn(progress);
							this.update();
							requestAnimationFrame(renderFrame);
						}
					}).bind(this);
				this.inAnimation = true;
				requestAnimationFrame(renderFrame);
			},
			stopAnimation: function () {
				this.inAnimation = false;
			},
			swing: function (p) {
				return -Math.cos(p * Math.PI) / 2 + 0.5;
			},

			getContainerX: function () {
				if (this.el) {
					return this.el.offsetWidth;
				} else {
					return 0;
				}
			},

			getContainerY: function () {
				return this.el.offsetHeight;
			},
			setContainerY: function (y) {
				y = y.toFixed(2);
				return this.pinchContainer.style.height = y + 'px';
			},
			setupMarkup: function () {
				this.pinchContainer = buildElement('<div class="pinch-zoom-container"></div>');
				this.el.parentNode.insertBefore(this.pinchContainer, this.el);
				this.pinchContainer.appendChild(this.el);

				this.pinchContainer.style.position = 'relative';

				this.el.style.webkitTransformOrigin = '0% 0%';
				this.el.style.mozTransformOrigin = '0% 0%';
				this.el.style.msTransformOrigin = '0% 0%';
				this.el.style.oTransformOrigin = '0% 0%';
				this.el.style.transformOrigin = '0% 0%';

				this.el.style.position = 'relative';
			},

			end: function () {
				this.hasInteraction = false;
				this.sanitize();
				this.update();
			},
			bindEvents: function () {
				var self = this;
				detectGestures(this.pinchParentNode, this);

				this.resizeHandler = this.update.bind(this);
				window.addEventListener('resize', this.resizeHandler);
				Array.from(this.el.querySelectorAll('canvas')).forEach(function (imgEl) {
					self.update.bind(self);
				});
			},
			update: function () {
				if (this.updatePlaned) {
					return;
				}
				this.updatePlaned = true;
				setTimeout((function () {
					this.updatePlaned = false;
					this.updateAspectRatio();
					var zoomFactor = this.getInitialZoomFactor() * this.zoomFactor,
						offsetX = (-this.offset.x / zoomFactor).toFixed(3),
						offsetY = (-this.offset.y / zoomFactor).toFixed(3);
					this.lastclientY = offsetY;

					var transform3d = 'scale3d(' + zoomFactor + ', ' + zoomFactor + ',1) ' +
						'translate3d(' + offsetX + 'px,' + offsetY + 'px,0px)',
						transform2d = 'scale(' + zoomFactor + ', ' + zoomFactor + ') ' +
							'translate(' + offsetX + 'px,' + offsetY + 'px)',
						removeClone = (function () {
							if (this.clone) {
								this.clone.remove();
								delete this.clone;
							}
						}).bind(this);
					if (!this.options.use2d || this.hasInteraction || this.inAnimation) {
						this.is3d = true;
						this.el.style.webkitTransform = transform3d;
						this.el.style.mozTransform = transform2d;
						this.el.style.msTransform = transform2d;
						this.el.style.oTransform = transform2d;
						this.el.style.transform = transform3d;
					} else {
						this.el.style.webkitTransform = transform2d;
						this.el.style.mozTransform = transform2d;
						this.el.style.msTransform = transform2d;
						this.el.style.oTransform = transform2d;
						this.el.style.transform = transform2d;
						this.is3d = false;
					}
					this.lastOffsets.shift();
					this.lastOffsets.push({
						x: this.offset.x,
						y: this.offset.y,
						time: Date.now()
					});
				}).bind(this), 0);
			},
			enable: function () {
				this.enabled = true;
			},
			disable: function () {
				this.enabled = false;
			},
			destroy: function () {
				window.removeEventListener('resize', this.resizeHandler);
				if (this.pinchContainer) {
					var parentNode = this.pinchContainer.parentNode;
					var childNode = this.pinchContainer.firstChild;
					parentNode.appendChild(childNode);
					parentNode.removeChild(this.pinchContainer);
				}
			}
		};

		var detectGestures = function (el, target) {
			var interaction = null,
				fingers = 0,
				lastTouchStart = null,
				startTouches = null,
				lastTouchY = null,
				clientY = null,
				lastclientY = 0,
				lastTop = 0,
				setInteraction = function (newInteraction, event) {
					if (interaction !== newInteraction) {
						if (interaction && !newInteraction) {
							switch (interaction) {
								case "zoom":
									target.handleZoomEnd(event);
									break;
								case 'drag':
									target.handleDragEnd(event);
									break;
							}
						}

						switch (newInteraction) {
							case 'zoom':
								target.handleZoomStart(event);
								break;
							case 'drag':
								target.handleDragStart(event);
								break;
						}
					}
					interaction = newInteraction;
				},

				updateInteraction = function (event) {
					if (fingers === 2) {
						setInteraction('zoom');
					} else if (fingers === 1 && target.canDrag()) {
						setInteraction('drag', event);
					} else {
						setInteraction(null, event);
					}
				},

				targetTouches = function (touches) {
					return Array.prototype.slice.call(touches).map(function (touch) {
						return {
							x: touch.pageX,
							y: touch.pageY
						};
					});
				},

				getDistance = function (a, b) {
					var x, y;
					x = a.x - b.x;
					y = a.y - b.y;
					return Math.sqrt(x * x + y * y);
				},

				calculateScale = function (startTouches, endTouches) {
					var startDistance = getDistance(startTouches[0], startTouches[1]),
						endDistance = getDistance(endTouches[0], endTouches[1]);
					return endDistance / startDistance;
				},

				cancelEvent = function (event) {
					event.stopPropagation();
					event.preventDefault();
				},

				detectDoubleTap = function (event) {
					var time = (new Date()).getTime();
					var pageY = event.changedTouches[0].pageY;
					var top = el.scrollTop || 0;
					if (fingers > 1) {
						lastTouchStart = null;
						lastTouchY = null;
						cancelEvent(event);
					}

					if (time - lastTouchStart < 300 && Math.abs(pageY - lastTouchY) < 10 && Math.abs(lastTop - top) < 10) {
						cancelEvent(event);
						target.handleDoubleTap(event);
						switch (interaction) {
							case "zoom":
								target.handleZoomEnd(event);
								break;
							case 'drag':
								target.handleDragEnd(event);
								break;
						}
					}

					if (fingers === 1) {
						lastTouchStart = time;
						lastTouchY = pageY;
						lastTop = top;
					}
				},
				firstMove = true;

			el.addEventListener('touchstart', function (event) {
				if (target.enabled) {
					firstMove = true;
					fingers = event.touches.length;
					detectDoubleTap(event);
					clientY = event.changedTouches[0].clientY;
					if (fingers > 1) {
						cancelEvent(event);
					}
				}
			});

			el.addEventListener('touchmove', function (event) {
				if (target.enabled) {
					lastclientY = event.changedTouches[0].clientY;
					if (firstMove) {
						updateInteraction(event);
						startTouches = targetTouches(event.touches);
					} else {
						switch (interaction) {
							case 'zoom':
								target.handleZoom(event, calculateScale(startTouches, targetTouches(event.touches)));
								break;
							case 'drag':
								target.handleDrag(event);
								break;
						}
						if (interaction) {
							target.update(lastclientY);
						}
					}
					if (fingers > 1) {
						cancelEvent(event);
					}
					firstMove = false;
				}
			});

			el.addEventListener('touchend', function (event) {
				if (target.enabled) {
					fingers = event.touches.length;
					if (fingers > 1) {
						cancelEvent(event);
					}
					updateInteraction(event);
				}
			});
		};

		return PinchZoom;
	};

	var PinchZoom = definePinchZoom();

	var Pdfh5 = function (dom, options) {
		this.version = version;
		this.container = dom;
		this.options = options;
		this.thePDF = null;
		this.totalNum = null;
		this.pages = null;
		this.initTime = 0;
		this.currentNum = 1;
		this.loadedCount = 0;
		this.endTime = 0;
		this.pinchZoom = null;
		this.timer = null;
		this.docWidth = document.documentElement.clientWidth;
		this.cache = {};
		this.eventType = {};
		this.cacheNum = 1;
		this.resizeEvent = false;
		this.cacheData = null;
		this.pdfjsLibPromise = null;
		this.pdfjsLib = null;
		this.currentEditorMode = null;
		this.searchResults = [];
		this.currentSearchIndex = 0;
		this.currentSearchQuery = null;
		this.intersectionObserver = null;
		this.pageRenderStartTimes = {};
		this.isZooming = false;
		this.zoomDisabled = false;
		this.scrollDisabled = false;
		this.zoomConstraints = {
			minScale: 0.5,
			maxScale: 4.0,
			step: 0.1
		};

		// 沙箱管理
		this.sandboxManager = null;
		this.sandboxEnabled = true;

		// 密码保护相关
		this.passwordPrompt = null;


		// 分段加载配置
		this.progressiveLoading = false;
		this.chunkSize = 65536; // 64KB分块大小
		this.maxMemoryPages = 5; // 最大内存页面数
		this.loadedPages = new Map(); // 已加载页面缓存
		this.loadingQueue = []; // 加载队列
		this.memoryUsage = 0; // 内存使用量统计

		// 编辑器相关属性
		this.annotationEditorMode = 'NONE';
		this.editorParams = {
			freeTextColor: '#000000',
			freeTextSize: 12,
			inkColor: '#000000',
			inkThickness: 1,
			inkOpacity: 1,
			stampImage: null
		};
		this.editorAnnotations = []; // 存储所有注释
		this.isEditing = false;
		this.selectedAnnotation = null; // 当前选择的注释
		this.currentEditingTextInput = null; // 当前编辑的文本输入框

		// 墨迹绘制相关属性
		this.isDrawingInk = false;
		this.currentInkPath = null;

		// 注释编辑器UI管理器
		this.annotationEditorUIManager = null;

		this.init(options);
	};

	Pdfh5.prototype = {
		init: async function (options) {

			try {
				this.pdfjsLib = await initPdfJs();

				// 初始化沙箱管理器
				this.initSandbox();
			} catch (error) {
				console.error('Failed to initialize PDF.js:', error);
				return;
			}

			if (this.container.pdfLoaded) {
				this.destroy();
			}

			var $style = document.createElement('style');
			$style.type = 'text/css';
			$style.textContent = css;
			document.head.appendChild($style);

			this.container.pdfLoaded = false;
			this.container.classList.add("pdfjs");
			this.initTime = new Date().getTime();

			this.options = this.options ? this.options : {};
			this.options.pdfurl = this.options.pdfurl ? this.options.pdfurl : null;
			this.options.data = this.options.data ? this.options.data : null;
			this.options.scale = this.options.scale ? this.options.scale : 1;
			this.options.zoomEnable = this.options.zoomEnable === false ? false : true;
			this.options.scrollEnable = this.options.scrollEnable === false ? false : true;
			this.options.loadingBar = this.options.loadingBar === false ? false : true;
			this.options.pageNum = this.options.pageNum === false ? false : true;

			// 密码配置项
			this.options.password = this.options.password || null;
			this.options.backTop = this.options.backTop === false ? false : true;
			this.options.resize = this.options.resize === false ? false : true;
			this.options.textLayer = this.options.textLayer === true ? true : false;
			this.options.goto = isNaN(this.options.goto) ? 0 : this.options.goto;

			this.progressiveLoading = this.options.progressiveLoading === true ? true : false;
			if (this.options.chunkSize) this.chunkSize = this.options.chunkSize;
			if (this.options.maxMemoryPages) this.maxMemoryPages = this.options.maxMemoryPages;

			if (pdfjsLib && window._pdfh5ResourcePaths) {
				if (this.options.workerSrc) {
					pdfjsLib.GlobalWorkerOptions.workerSrc = this.options.workerSrc;
				}

				if (!this.options.cMapUrl) {
					this.options.cMapUrl = window._pdfh5ResourcePaths.cMapUrl;
				}
				if (!this.options.standardFontDataUrl) {
					this.options.standardFontDataUrl = window._pdfh5ResourcePaths.standardFontDataUrl;
				}
				if (!this.options.iccUrl) {
					this.options.iccUrl = window._pdfh5ResourcePaths.iccUrl;
				}
				if (!this.options.wasmUrl) {
					this.options.wasmUrl = window._pdfh5ResourcePaths.wasmUrl;
				}
			}

			this.createHTML();
			this.bindEvents();

			this.initEditorEvents();

			this.loadPDF();
		},

		createHTML: function () {
			var html = '';

			if (this.options.loadingBar) {
				html += '<div class="loadingBar">' +
					'<div class="progress">' +
					' <div class="glimmer">' +
					'</div>' +
					' </div>' +
					'</div>';
			}

			html += '<div class="pageNum">' +
				'<div class="pageNum-bg"></div>' +
				' <div class="pageNum-num">' +
				' <span class="pageNow">1</span>/' +
				'<span class="pageTotal">1</span>' +
				'</div>' +
				' </div>' +
				'<div class="backTop">' +
				'</div>' +
				'<div class="loadEffect loading"></div>';
			this.container.innerHTML = html;

			var viewer = document.createElement("div");
			viewer.className = 'pdfViewer';
			var viewerContainer = document.createElement("div");
			viewerContainer.className = 'viewerContainer';
			viewerContainer.appendChild(viewer);
			this.container.appendChild(viewerContainer);
			this.viewer = viewer;
			this.viewerContainer = viewerContainer;

			this.pageNum = this.container.querySelector('.pageNum');
			this.pageNow = this.pageNum.querySelector('.pageNow');
			this.pageTotal = this.pageNum.querySelector('.pageTotal');

			this.loadingBar = this.container.querySelector('.loadingBar');
			if (this.loadingBar) {
				this.progress = this.loadingBar.querySelector('.progress');
			} else {
				this.progress = null;
			}

			this.backTop = this.container.querySelector('.backTop');
			this.loading = this.container.querySelector('.loading');
		},

		bindEvents: function () {
			var self = this;

			if (!this.options.scrollEnable) {
				this.viewerContainer.style.overflow = "hidden";
			} else {
				this.viewerContainer.style.overflow = "auto";
			}

			this.viewerContainer.addEventListener('scroll', function () {
				self.handleScroll();
			});

			this.backTop.addEventListener("click", function () {
				self.scrollToTop();
			});

			if (this.options.resize !== false) {
				var resizeTimeout;
				this.resizeHandler = function () {
					clearTimeout(resizeTimeout);
					resizeTimeout = setTimeout(function () {
						if (self.container.pdfLoaded && self.thePDF) {
							self.updateAllPagesScale();
						}
					}, 100);
				};

				window.addEventListener('resize', this.resizeHandler);
			}
		},

		updateAllPagesScale: function () {
			var self = this;

			if (!self.container.pdfLoaded || !self.thePDF) {
				return;
			}

			for (var pageNum = 1; pageNum <= self.totalNum; pageNum++) {
				var pageCache = self.cache[pageNum + ""];
				if (pageCache && pageCache.container && pageCache.container.querySelector('canvas')) {
					self.updatePageScale(pageNum);
				}
			}
		},

		updateVisiblePagesScale: function () {
			var self = this;

			if (!self.container.pdfLoaded || !self.thePDF) {
				return;
			}

			if (self.intersectionObserver) {
				var visiblePages = [];
				for (var pageNum = 1; pageNum <= self.totalNum; pageNum++) {
					var pageCache = self.cache[pageNum + ""];
					if (pageCache && pageCache.container) {
						var rect = pageCache.container.getBoundingClientRect();
						var containerRect = self.viewerContainer.getBoundingClientRect();

						if (rect.top < containerRect.bottom && rect.bottom > containerRect.top) {
							visiblePages.push(pageNum);
						}
					}
				}

				visiblePages.forEach(function (pageNum) {
					var pageCache = self.cache[pageNum + ""];
					if (pageCache && pageCache.container && pageCache.container.querySelector('canvas')) {
						self.updatePageScale(pageNum);
					}
				});
			} else {
				self.updateAllPagesScale();
			}
		},

		updatePageScale: function (pageNum) {
			var self = this;
			var pageCache = self.cache[pageNum + ""];

			if (!pageCache || !pageCache.container) {
				return;
			}

			if (self.loadingPages && self.loadingPages.has(pageNum)) {
				return;
			}

			if (!self.loadingPages) {
				self.loadingPages = new Set();
			}
			self.loadingPages.add(pageNum);

			self.thePDF.getPage(pageNum).then(function (page) {
				var userScale = self.scale || 1.0;

				if (userScale === 1.0) {
					var baseViewport = page.getViewport({ scale: 1.0 });
					var pageWidth = baseViewport.width;
					var pageHeight = baseViewport.height;

					var containerWidth = self.viewer.clientWidth || self.viewer.offsetWidth;
					var containerHeight = self.viewer.clientHeight || self.viewer.offsetHeight;

					// 修复PDF容器高度异常小的问题
					if (containerHeight < 100) {
						// 如果容器高度异常小，使用窗口高度减去一些边距
						containerHeight = window.innerHeight - 200; // 减去200px给其他元素留空间
					}

					var SCROLLBAR_PADDING = 40;
					var VERTICAL_PADDING = 5;
					var hPadding = SCROLLBAR_PADDING;
					var vPadding = VERTICAL_PADDING;

					var pageWidthScaleFactor = 1;

					var currentPageScale = 1.0;

					var pageWidthScale = (containerWidth - hPadding) / pageWidth * currentPageScale / pageWidthScaleFactor;
					var pageHeightScale = (containerHeight - vPadding) / pageHeight * currentPageScale;

					var isPortrait = pageHeight > pageWidth;
					var horizontalScale = isPortrait ? pageWidthScale : Math.min(pageHeightScale, pageWidthScale);
					userScale = Math.min(1.25, horizontalScale);
				}

				self.renderPage(page, pageNum, { scale: userScale, forceRerender: true }, 100 / self.totalNum);

				var textLayerDiv = pageCache.container.querySelector('.textLayer');
				if (textLayerDiv && textLayerDiv.textLayer) {
					var PDF_TO_CSS_UNITS = 96.0 / 72.0; // 1.333...
					var newViewport = page.getViewport({ scale: userScale * PDF_TO_CSS_UNITS });

					var pageWidth = newViewport.rawDims.pageWidth;
					var pageHeight = newViewport.rawDims.pageHeight;

					textLayerDiv.textLayer.update({
						viewport: newViewport
					});

					var w = 'var(--total-scale-factor) * ' + pageWidth + 'px';
					var h = 'var(--total-scale-factor) * ' + pageHeight + 'px';

					textLayerDiv.style.width = w;
					textLayerDiv.style.height = h;

					textLayerDiv.style.transform = 'none';
					textLayerDiv.style.transformOrigin = '0 0';

					var containerScale = pageCache.container.style.getPropertyValue('--scale-factor') || newViewport.scale;
					textLayerDiv.style.setProperty('--scale-factor', containerScale);
					textLayerDiv.style.setProperty('--user-unit', '1');
					textLayerDiv.style.setProperty('--total-scale-factor', 'calc(var(--scale-factor) * var(--user-unit))');
				}

				if (self.loadingPages) {
					self.loadingPages.delete(pageNum);
				}
			}).catch(function (error) {
				console.error('Error updating page scale:', error);

				if (self.loadingPages) {
					self.loadingPages.delete(pageNum);
				}
			});
		},

		getContainerWidth: function (container) {
			var current = container;
			while (current && current !== document.body) {
				var computedStyle = window.getComputedStyle(current);
				var width = computedStyle.width;
				var maxWidth = computedStyle.maxWidth;

				if (width !== 'auto' && width !== '100%' && width !== '100vw') {
					var widthValue = parseFloat(width);
					if (widthValue > 0) {
						return widthValue;
					}
				}

				if (maxWidth !== 'none' && maxWidth !== '100%' && maxWidth !== '100vw') {
					var maxWidthValue = parseFloat(maxWidth);
					if (maxWidthValue > 0) {
						return maxWidthValue;
					}
				}

				current = current.parentElement;
			}

			var docWidth = document.documentElement.clientWidth;
			return docWidth;
		},

		loadPDF: function () {
			var url = this.options.pdfurl;
			var data = this.options.data;

			if (url) {
				this.renderPdf(this.options, { url: url });
			} else if (data) {
				this.renderPdf(this.options, { data: data });
			} else {
				console.error("Expect options.pdfurl or options.data!");
			}
		},

		renderPdf: function (options, obj) {
			var self = this;
			this.container.pdfLoaded = true;

			// 字体配置
			obj.cMapUrl = options.cMapUrl || (window._pdfh5ResourcePaths ? window._pdfh5ResourcePaths.cMapUrl : '../cmaps/');
			obj.standardFontDataUrl = options.standardFontDataUrl || (window._pdfh5ResourcePaths ? window._pdfh5ResourcePaths.standardFontDataUrl : '../standard_fonts/');

			// 颜色管理
			obj.iccUrl = options.iccUrl || (window._pdfh5ResourcePaths ? window._pdfh5ResourcePaths.iccUrl : '../iccs/');
			// 图片渲染
			obj.wasmUrl = options.wasmUrl || (window._pdfh5ResourcePaths ? window._pdfh5ResourcePaths.wasmUrl : '../wasm/');

			obj.cMapPacked = options.cMapPacked !== false; // 默认启用压缩的CMap
			obj.disableFontFace = options.disableFontFace === true; // 默认不禁用字体
			obj.enableXfa = options.enableXfa !== false; // 默认启用XFA
			obj.enableHWA = options.enableHWA !== false; // 默认启用硬件加速，对图片渲染很重要
			obj.verbosity = options.verbosity || 1; // 设置详细程度


			if (options.httpHeaders) {
				obj.httpHeaders = options.httpHeaders;
			}
			if (options.withCredentials) {
				obj.withCredentials = true;
			}
			if (options.password) {
				obj.password = options.password;
			}

			// 分段加载配置
			if (self.progressiveLoading) {
				obj.disableStream = false;
				obj.disableAutoFetch = false;
				obj.rangeChunkSize = self.chunkSize;

				obj.maxImageSize = options.maxImageSize || 8388608; // 8388608最大图片大小，兼容iOS Safari
				obj.canvasMaxAreaInBytes = options.canvasMaxAreaInBytes || 8388608; // 8388608最大canvas面积 iOS Safari浏览器canvas限制约为16777216 

			}

			this.pdfjsLib.getDocument(obj).promise.then(function (pdf) {
				self.loading.style.display = "none";
				self.thePDF = pdf;
				self.totalNum = pdf.numPages;
				if (options.limit > 0) {
					self.totalNum = options.limit;
				}
				self.pageTotal.innerText = self.totalNum;



				if (!self.eventBus) {
					self.eventBus = self;
				}

				// 初始化AnnotationEditorUIManager（
				if (self.pdfjsLib.AnnotationEditorUIManager && self.thePDF.annotationStorage && self.eventBus) {
					try {
						self.annotationEditorUIManager = new self.pdfjsLib.AnnotationEditorUIManager(
							self.container,
							self.pdfViewer,
							null, // viewerAlert
							null, // altTextManager
							null, // commentManager
							null, // signatureManager
							self.eventBus,
							self.thePDF,
							null, // pageColors
							null, // highlightColors
							false, // enableHighlightFloatingButton
							false, // enableUpdatedAddImage
							false, // enableNewAltTextWhenAddingImage
							null, // mlManager
							null, // editorUndoBar
							false  // supportsPinchToZoom
						);

						setTimeout(function () {
							for (var i = 1; i <= self.totalNum; i++) {
								self.createAnnotationEditorLayer(i);
							}
						}, 100);
					} catch (error) {
					}
				}

				if (self.thePDF && self.thePDF.annotationStorage) {
					self.thePDF.annotationStorage.onSetModified = function () {
					};

					self.thePDF.annotationStorage.onResetModified = function () {
					};
				}

				// 如果正在验证密码且PDF加载成功，隐藏密码框
				if (self.passwordValidating) {
					self.hidePasswordPrompt();
					self.passwordValidating = false; // 重置标志
				}

				self.trigger('ready', { totalPages: self.totalNum });

				if (self.progressiveLoading) {
					self.initProgressiveLoading(pdf, options);
				} else if (options.lazyLoad) {
					// 懒加载模式：只渲染可见页面
					self.initLazyLoading(pdf, options);
				} else {
					// 传统模式：渲染所有页面
					self.renderAllPages(pdf, options);
				}
			}).catch(function (err) {
				self.loading.style.display = "none";

				// 处理密码错误
				if (err.name === 'PasswordException') {
					self.handlePasswordError(err);
				} else {
					console.error('PDF loading error:', err);
					self.trigger('error', { message: 'PDF加载失败: ' + err.message });
				}
			});
		},

		renderAllPages: function (pdf, options) {
			var self = this;

			// 初始化缓存
			for (var i = 1; i <= self.totalNum; i++) {
				self.cache[i + ""] = {
					page: null,
					loaded: false,
					container: null,
					scaledViewport: null,
					canvas: null,
					imgWidth: null
				};
			}

			// 初始化当前页码
			self.currentNum = 1;

			// 检查是否有goto配置
			if (self.options.goto && self.options.goto > 0 && self.options.goto <= self.totalNum) {
				self.currentNum = self.options.goto;
			}

			// 传统模式：一次性加载所有页面
			var promise = Promise.resolve();
			var num = Math.floor(100 / self.totalNum).toFixed(2);

			// 渲染所有页面
			for (var i = 1; i <= self.totalNum; i++) {
				promise = promise.then(function (pageNum) {
					return pdf.getPage(pageNum).then(function (page) {
						return self.renderPage(page, pageNum, options, num);
					});
				}.bind(null, i));
			}

			return promise.then(function () {
				// 初始化TouchManager - 更好的手势缩放
				if (self.options.zoomEnable) {
					self.initTouchManager();
				}
			});
		},



		// 预计算所有页面尺寸
		preCalculateAllPageSizes: function (pdf, options) {
			var self = this;

			// 获取pdfViewer的实际尺寸
			var pdfViewerWidth = self.viewer.clientWidth || self.viewer.offsetWidth;
			var pdfViewerHeight = self.viewer.clientHeight || self.viewer.offsetHeight;

			// 修复PDF容器高度异常小的问题
			if (pdfViewerHeight < 100) {
				pdfViewerHeight = window.innerHeight - 200;
			}

			// 计算pdfViewer的实际可用宽度（减去padding）
			var pdfViewerStyle = window.getComputedStyle(self.viewer);
			var paddingLeft = parseFloat(pdfViewerStyle.paddingLeft) || 0;
			var paddingRight = parseFloat(pdfViewerStyle.paddingRight) || 0;
			var availableWidth = pdfViewerWidth - paddingLeft - paddingRight;

			// 预计算所有页面的尺寸
			var pageSizePromises = [];
			for (var i = 1; i <= self.totalNum; i++) {
				pageSizePromises.push(
					pdf.getPage(i).then(function (pageNum) {
						return function (page) {
							return self.calculatePageSize(page, pageNum, availableWidth, pdfViewerHeight, options);
						};
					}(i))
				);
			}

			return Promise.all(pageSizePromises).then(function (pageSizes) {
				// 存储所有页面的预计算尺寸
				self.preCalculatedSizes = pageSizes;
				return pageSizes;
			});
		},

		// 计算单个页面的尺寸
		calculatePageSize: function (page, pageNum, availableWidth, pdfViewerHeight, options) {
			var self = this;
			var PDF_TO_CSS_UNITS = 96.0 / 72.0;
			var userScale = options.scale || 1.0;

			// 获取PDF页面的基础尺寸
			var baseViewport = page.getViewport({ scale: 1.0 });
			var pageWidth = baseViewport.width;
			var pageHeight = baseViewport.height;

			// 如果用户没有指定缩放值，使用与renderPage完全一致的自动缩放逻辑
			if (userScale === 1.0) {
				// 使用与renderPage完全一致的缩放计算逻辑
				var SCROLLBAR_PADDING = 40;
				var VERTICAL_PADDING = 5;
				var hPadding = SCROLLBAR_PADDING;
				var vPadding = VERTICAL_PADDING;

				// 计算页面宽度缩放
				var pageWidthScale = (availableWidth - hPadding) / pageWidth;
				var pageHeightScale = (pdfViewerHeight - vPadding) / pageHeight;

				// 使用官方的"auto"模式逻辑，与renderPage保持一致
				var isPortrait = pageHeight > pageWidth;
				var horizontalScale = isPortrait ? pageWidthScale : Math.min(pageHeightScale, pageWidthScale);
				userScale = Math.min(1.25, horizontalScale); // MAX_AUTO_SCALE = 1.25

				// 设置合理的最小缩放限制，确保内容可见
				userScale = Math.max(userScale, 0.2); // 最小20%
			}

			// 计算最终的viewport
			var scaledViewport = page.getViewport({ scale: userScale * PDF_TO_CSS_UNITS });

			// 确保pageContainer宽度不超过pdfViewer的可用宽度
			var finalWidth = Math.min(scaledViewport.width, availableWidth);
			var finalHeight = scaledViewport.height;

			// 如果宽度被限制，按比例调整高度
			if (finalWidth < scaledViewport.width) {
				var scaleRatio = finalWidth / scaledViewport.width;
				finalHeight = scaledViewport.height * scaleRatio;
			}

			return {
				pageNum: pageNum,
				width: finalWidth,
				height: finalHeight,
				scale: userScale,
				viewport: scaledViewport
			};
		},

		// 懒加载初始化
		initLazyLoading: function (pdf, options) {
			var self = this;

			// 初始化内存管理
			self.loadedPages = new Map();
			self.maxMemoryPages = self.options.maxMemoryPages || 5; // 默认最多保留5页

			// 初始化缓存
			for (var i = 1; i <= self.totalNum; i++) {
				self.cache[i + ""] = {
					page: null,
					loaded: false,
					container: null,
					scaledViewport: null,
					canvas: null,
					imgWidth: null,
					pageHeight: 0,  // 存储页面实际高度
					pageTop: 0      // 存储页面顶部位置
				};
			}

			// 初始化当前页码
			self.currentNum = 1;

			// 预计算所有页面尺寸，然后创建容器
			self.preCalculateAllPageSizes(pdf, options).then(function () {
				// 使用预计算的尺寸创建页面容器占位符
				for (var i = 1; i <= self.totalNum; i++) {
					self.createPageContainerWithPreCalculatedSize(i, options);
				}

				// 继续原有的懒加载逻辑
				self.continueLazyLoading(pdf, options);
			});
		},

		// 使用预计算尺寸创建页面容器
		createPageContainerWithPreCalculatedSize: function (pageNum, options) {
			var self = this;
			var container = document.createElement('div');
			container.className = 'pageContainer pageContainer' + pageNum;
			container.setAttribute('name', 'page=' + pageNum);
			container.setAttribute('data-page', pageNum);

			// 使用预计算的尺寸
			if (self.preCalculatedSizes && self.preCalculatedSizes[pageNum - 1]) {
				var pageSize = self.preCalculatedSizes[pageNum - 1];
				container.style.width = pageSize.width + 'px';
				container.style.height = pageSize.height + 'px';
				container["data-scale"] = pageSize.width / pageSize.height;

				// 设置CSS变量
				container.style.setProperty('--scale-factor', pageSize.viewport.scale);
			} else {
				// 如果没有预计算尺寸，使用默认尺寸
				container.style.width = '100%';
				container.style.height = 'auto';
				container["data-scale"] = 1.0;
			}

			self.cache[pageNum + ""].container = container;
			self.viewer.appendChild(container);
		},

		// 继续懒加载逻辑
		continueLazyLoading: function (pdf, options) {
			var self = this;

			// 立即渲染第一页（确保有内容显示）
			if (self.totalNum > 0) {
				// 检查是否有goto配置
				var startPage = 1;
				if (self.options.goto && self.options.goto > 0 && self.options.goto <= self.totalNum) {
					startPage = self.options.goto;
					self.currentNum = startPage;
				}
				self.renderPageLazy(pdf, startPage, options);

				// 如果有goto配置，延迟滚动到指定页面
				if (self.options.goto && self.options.goto > 1) {
					setTimeout(function () {
						self.scrollToPage(self.options.goto);
					}, 100);
				}
			}

			// 懒加载模式下隐藏loadingBar
			self.hideLoadingBarForLazyLoading();

			// 使用滚动事件监听器替代 IntersectionObserver
			self.initScrollBasedLazyLoading(pdf, options);

			// 初始化TouchManager
			if (self.options.zoomEnable) {
				self.initTouchManager();
			}
		},

		// 懒加载模式下隐藏loadingBar
		hideLoadingBarForLazyLoading: function () {
			var self = this;

			// 设置进度条为100%
			if (self.options.loadingBar && self.progress) {
				self.progress.style.width = "100%";
			}

			// 延迟隐藏loadingBar，确保用户能看到100%的进度
			if (self.loadingBar) {
				setTimeout(function () {
					self.loadingBar.style.display = "none";

					// 触发懒加载完成事件
					var time = new Date().getTime();
					self.endTime = time - self.initTime;

					// 触发完成事件
					var arr1 = self.eventType["complete"];
					if (arr1 && arr1 instanceof Array) {
						for (var i = 0; i < arr1.length; i++) {
							arr1[i] && arr1[i].call(self, "success", "pdf懒加载初始化完成", self.endTime);
						}
					}
				}, 300);
			}
		},

		// 基于滚动位置的懒加载
		initScrollBasedLazyLoading: function (pdf, options) {
			var self = this;

			// 获取所有页面的实际高度和位置
			self.updatePagePositions();

			// 防抖机制，避免频繁调用
			var scrollTimeout = null;
			self.viewerContainer.addEventListener('scroll', function () {
				if (scrollTimeout) {
					clearTimeout(scrollTimeout);
				}
				scrollTimeout = setTimeout(function () {
					// 检查并加载可见页面
					self.checkAndLoadVisiblePages(pdf, options);

					// 懒加载模式也需要内存管理
					if (self.loadedPages && self.loadedPages.size > self.maxMemoryPages) {
						self.forceCleanupMemory();
					}
				}, 100); // 100ms防抖
			});

			// 初始检查
			setTimeout(function () {
				self.checkAndLoadVisiblePages(pdf, options);
			}, 100);
		},

		// 更新页面位置信息
		updatePagePositions: function () {
			var self = this;
			var currentTop = 0;


			// 获取第一页的实际高度作为默认高度
			var defaultPageHeight = 400; // 更小的默认高度
			if (self.cache["1"] && self.cache["1"].loaded && self.cache["1"].scaledViewport) {
				defaultPageHeight = self.cache["1"].scaledViewport.height;
			}

			for (var i = 1; i <= self.totalNum; i++) {
				var container = self.cache[i + ""].container;
				if (container) {
					// 如果页面已加载，使用实际高度
					if (self.cache[i + ""].loaded && self.cache[i + ""].scaledViewport) {
						self.cache[i + ""].pageHeight = self.cache[i + ""].scaledViewport.height;
					} else {
						// 使用第一页的高度作为默认高度
						self.cache[i + ""].pageHeight = defaultPageHeight;
					}

					self.cache[i + ""].pageTop = currentTop;
					currentTop += self.cache[i + ""].pageHeight + 8; // 8px是页面间距
				}
			}
		},

		// 检查并加载可见页面
		checkAndLoadVisiblePages: function (pdf, options) {
			// 分段加载模式下，使用Intersection Observer处理页面加载
			// 此方法仅在懒加载模式下使用
			if (this.progressiveLoading) {
				return;
			}

			var self = this;
			var scrollTop = self.viewerContainer.scrollTop;
			var containerHeight = self.viewerContainer.clientHeight;

			// 只加载当前视口附近的页面，不要一次性加载太多
			var buffer = 100; // 减小缓冲区域
			var loadTop = scrollTop - buffer;
			var loadBottom = scrollTop + containerHeight + buffer;


			var loadedCount = 0;
			var toLoad = []; // 收集需要加载的页面

			for (var i = 1; i <= self.totalNum; i++) {
				if (!self.cache[i + ""].loaded) {
					var container = self.cache[i + ""].container;
					if (container) {
						// 使用DOM元素的实际位置
						var containerRect = container.getBoundingClientRect();
						var viewerRect = self.viewerContainer.getBoundingClientRect();

						// 计算相对于滚动容器的位置
						var pageTop = containerRect.top - viewerRect.top + scrollTop;
						var pageBottom = pageTop + containerRect.height;

						// 检查页面是否在加载范围内
						if (pageBottom > loadTop && pageTop < loadBottom) {
							toLoad.push(i);
						}
					}
				} else {
					loadedCount++;
				}
			}

			// 只加载最接近视口的页面，避免一次性加载太多
			if (toLoad.length > 0) {
				// 按距离视口中心的距离排序
				var center = scrollTop + containerHeight / 2;
				toLoad.sort(function (a, b) {
					var containerA = self.cache[a + ""].container;
					var containerB = self.cache[b + ""].container;
					var rectA = containerA.getBoundingClientRect();
					var rectB = containerB.getBoundingClientRect();
					var viewerRect = self.viewerContainer.getBoundingClientRect();

					var posA = rectA.top - viewerRect.top + scrollTop;
					var posB = rectB.top - viewerRect.top + scrollTop;

					return Math.abs(posA - center) - Math.abs(posB - center);
				});

				// 只加载前2个最接近的页面
				var maxLoad = Math.min(2, toLoad.length);
				for (var j = 0; j < maxLoad; j++) {
					var pageNum = toLoad[j];
					self.renderPageLazy(pdf, pageNum, options);
				}
			}

		},

		// 创建页面容器占位符
		createPageContainer: function (pageNum, options, page) {
			var self = this;
			var container = document.createElement('div');
			container.className = 'pageContainer pageContainer' + pageNum;
			container.setAttribute('name', 'page=' + pageNum);
			container.setAttribute('data-page', pageNum);

			// 使用与官方viewer.mjs相同的缩放因子和自动缩放逻辑
			var PDF_TO_CSS_UNITS = 96.0 / 72.0;
			var userScale = options.scale || 1.0;

			// 如果用户没有指定缩放值，使用官方的"auto"模式
			if (userScale === 1.0) {
				// 使用默认的自动缩放值，这个值会在renderPage中重新计算
				userScale = 1.0;
			}

			var effectiveScale = userScale * PDF_TO_CSS_UNITS;

			// 设置容器占位尺寸 - 使用与renderPage相同的计算逻辑
			if (page) {
				// 获取PDF页面的基础尺寸
				var baseViewport = page.getViewport({ scale: 1.0 });
				var pageWidth = baseViewport.width;
				var pageHeight = baseViewport.height;

				// 获取pdfViewer的实际尺寸
				var pdfViewerWidth = self.viewer.clientWidth || self.viewer.offsetWidth;
				var pdfViewerHeight = self.viewer.clientHeight || self.viewer.offsetHeight;

				// 修复PDF容器高度异常小的问题
				if (pdfViewerHeight < 100) {
					// 如果容器高度异常小，使用窗口高度减去一些边距
					pdfViewerHeight = window.innerHeight - 200; // 减去200px给其他元素留空间
				}

				// 计算pdfViewer的实际可用宽度（减去padding）
				var pdfViewerStyle = window.getComputedStyle(self.viewer);
				var paddingLeft = parseFloat(pdfViewerStyle.paddingLeft) || 0;
				var paddingRight = parseFloat(pdfViewerStyle.paddingRight) || 0;
				var availableWidth = pdfViewerWidth - paddingLeft - paddingRight;

				// 计算缩放比例
				var SCROLLBAR_PADDING = 40;
				var VERTICAL_PADDING = 5;
				var hPadding = SCROLLBAR_PADDING;
				var vPadding = VERTICAL_PADDING;

				var pageWidthScale = (availableWidth - hPadding) / pageWidth;
				var pageHeightScale = (pdfViewerHeight - vPadding) / pageHeight;

				var isPortrait = pageHeight > pageWidth;
				var horizontalScale = isPortrait ? pageWidthScale : Math.min(pageHeightScale, pageWidthScale);
				var userScale = Math.min(1.25, horizontalScale);

				// 计算最终的viewport
				var scaledViewport = page.getViewport({ scale: userScale * PDF_TO_CSS_UNITS });

				// 确保pageContainer宽度不超过pdfViewer的可用宽度
				var finalWidth = Math.min(scaledViewport.width, availableWidth);
				var finalHeight = scaledViewport.height;

				// 如果宽度被限制，按比例调整高度
				if (finalWidth < scaledViewport.width) {
					var scaleRatio = finalWidth / scaledViewport.width;
					finalHeight = scaledViewport.height * scaleRatio;
				}

				container.style.width = finalWidth + 'px';
				container.style.height = finalHeight + 'px';
				container["data-scale"] = finalWidth / finalHeight;
			} else {
				// 如果没有page对象，使用默认尺寸
				container.style.width = '100%';
				container.style.height = 'auto';
				container["data-scale"] = 1.0;
			}

			// 设置与官方viewer.mjs一致的CSS变量
			container.style.setProperty('--scale-factor', effectiveScale);

			self.cache[pageNum + ""].container = container;
			self.viewer.appendChild(container);
		},

		// 懒加载渲染页面
		renderPageLazy: function (pdf, pageNum, options) {
			var self = this;

			if (self.cache[pageNum + ""].loaded) {
				return Promise.resolve();
			}

			return pdf.getPage(pageNum).then(function (page) {
				var num = Math.floor(100 / self.totalNum).toFixed(2);
				return self.renderPage(page, pageNum, options, num);
			}).then(function () {
				// 懒加载模式下也需要更新loadedPages
				if (self.loadedPages) {
					self.loadedPages.set(pageNum, {
						page: self.cache[pageNum + ""].page,
						loaded: true,
						loadTime: new Date().getTime(),
						container: self.cache[pageNum + ""].container
					});
				}
			}).catch(function (error) {
				console.error('Failed to render page', pageNum, error);
			});
		},

		renderPage: function (page, pageNum, options, progressNum) {
			var self = this;
			// 记录页面渲染开始时间
			self.pageRenderStartTimes[pageNum] = new Date().getTime();

			// 使用与官方viewer.mjs完全一致的缩放逻辑
			var PDF_TO_CSS_UNITS = 96.0 / 72.0;
			var userScale = options.scale || 1.0;
			var baseViewport = page.getViewport({ scale: 1.0 });


			// 如果用户没有指定缩放值，使用智能的"auto"模式
			if (userScale === 1.0) {
				// 获取页面基础尺寸
				var pageWidth = baseViewport.width;
				var pageHeight = baseViewport.height;

				// 获取pdfViewer的实际尺寸（与createPageContainer保持一致）
				var pdfViewerWidth = self.viewer.clientWidth || self.viewer.offsetWidth;
				var pdfViewerHeight = self.viewer.clientHeight || self.viewer.offsetHeight;

				// 修复PDF容器高度异常小的问题
				if (pdfViewerHeight < 100) {
					// 如果容器高度异常小，使用窗口高度减去一些边距
					pdfViewerHeight = window.innerHeight - 200; // 减去200px给其他元素留空间
				}

				// 计算pdfViewer的实际可用宽度（减去padding）
				var pdfViewerStyle = window.getComputedStyle(self.viewer);
				var paddingLeft = parseFloat(pdfViewerStyle.paddingLeft) || 0;
				var paddingRight = parseFloat(pdfViewerStyle.paddingRight) || 0;
				var availableWidth = pdfViewerWidth - paddingLeft - paddingRight;

				// 使用统一的缩放计算逻辑
				var SCROLLBAR_PADDING = 40;
				var VERTICAL_PADDING = 5;
				var hPadding = SCROLLBAR_PADDING;
				var vPadding = VERTICAL_PADDING;

				// 计算页面宽度缩放
				var pageWidthScale = (availableWidth - hPadding) / pageWidth;
				var pageHeightScale = (pdfViewerHeight - vPadding) / pageHeight;

				// 使用官方的"auto"模式逻辑
				var isPortrait = pageHeight > pageWidth;
				var horizontalScale = isPortrait ? pageWidthScale : Math.min(pageHeightScale, pageWidthScale);
				userScale = Math.min(1.25, horizontalScale); // MAX_AUTO_SCALE = 1.25

			}
			// 如果用户指定了缩放值（如1.5、2.0等），直接使用用户设置的值

			var scaledViewport = page.getViewport({ scale: userScale * PDF_TO_CSS_UNITS });

			// 检查容器是否已存在（懒加载模式）
			var container = self.cache[pageNum + ""].container;
			if (!container) {
				container = document.createElement('div');
				container.className = 'pageContainer pageContainer' + pageNum;
				container.setAttribute('name', 'page=' + pageNum);

				self.viewer.appendChild(container);
			}

			var pdfViewerWidth = self.viewer.clientWidth || self.viewer.offsetWidth;
			var pdfViewerHeight = self.viewer.clientHeight || self.viewer.offsetHeight;

			var pdfViewerStyle = window.getComputedStyle(self.viewer);
			var paddingLeft = parseFloat(pdfViewerStyle.paddingLeft) || 0;
			var paddingRight = parseFloat(pdfViewerStyle.paddingRight) || 0;
			var availableWidth = pdfViewerWidth - paddingLeft - paddingRight;

			var finalWidth = Math.min(scaledViewport.width, availableWidth);
			var finalHeight = scaledViewport.height;

			if (finalWidth < scaledViewport.width) {
				var scaleRatio = finalWidth / scaledViewport.width;
				finalHeight = scaledViewport.height * scaleRatio;
			}


			container.style.width = finalWidth + 'px';
			container.style.height = finalHeight + 'px';

			container.style.setProperty('--scale-factor', scaledViewport.scale);

			self.cache[pageNum + ""].container = container;
			self.cache[pageNum + ""].scaledViewport = scaledViewport;

			return self.renderCanvas(page, scaledViewport, pageNum, progressNum, container, options, scaledViewport);
		},

		renderCanvas: function (page, viewport, pageNum, num, container, options, scaledViewport) {
			var self = this;

			// 检查是否已经存在canvas，避免重复创建
			var existingCanvas = container.querySelector('canvas');
			if (existingCanvas) {
				// 如果是resize更新，需要重新渲染canvas内容
				if (options && options.forceRerender) {
					// 移除旧的canvas
					existingCanvas.remove();
				} else {
					// 普通情况，避免重复创建
					return Promise.resolve();
				}
			}

			var canvas = document.createElement("canvas");
			// 根据 enableHWA 设置 willReadFrequently，这对图片渲染很重要
			var enableHWA = this.options.enableHWA !== false;
			var context = canvas.getContext('2d', {
				alpha: false,
				willReadFrequently: !enableHWA
			});

			// 使用设备像素比设置 Canvas 实际尺寸，提高清晰度
			var devicePixelRatio = window.devicePixelRatio || 1;

			// 根据pageContainer的实际尺寸重新计算viewport缩放比例
			var containerWidth = container.clientWidth || container.offsetWidth;
			var containerHeight = container.clientHeight || container.offsetHeight;

			// 如果容器尺寸为0（初始渲染时），使用原始viewport
			if (containerWidth === 0 || containerHeight === 0) {
				var canvasWidth = viewport.width;
				var canvasHeight = viewport.height;
				var adjustedViewport = viewport;
			} else {
				// 计算缩放比例，确保完全显示在pageContainer内
				var scaleX = containerWidth / viewport.width;
				var scaleY = containerHeight / viewport.height;
				var scale = Math.min(scaleX, scaleY); // 选择较小的缩放比例，确保完全显示

				// 计算缩放后的canvas尺寸
				var canvasWidth = viewport.width * scale;
				var canvasHeight = viewport.height * scale;

				// 重新计算viewport的缩放比例，让PDF内容也按比例缩小
				var originalScale = viewport.scale;
				var adjustedScale = originalScale * scale;

				// 创建调整后的viewport，让PDF内容按比例渲染
				var adjustedViewport = page.getViewport({ scale: adjustedScale });
			}

			// 设置canvas的实际尺寸（考虑设备像素比）
			canvas.width = canvasWidth * devicePixelRatio;
			canvas.height = canvasHeight * devicePixelRatio;

			canvas.style.width = canvasWidth + 'px';
			canvas.style.height = canvasHeight + 'px';

			// 缩放上下文以匹配设备像素比
			context.scale(devicePixelRatio, devicePixelRatio);


			var renderObj = {
				canvasContext: context,
				viewport: adjustedViewport
			};

			return page.render(renderObj).promise.then(function () {
				self.loadedCount++;

				// 隐藏加载效果
				var loadEffect = container.querySelector('.loadEffect');
				if (loadEffect) {
					loadEffect.style.display = "none";
				}

				canvas.className = "canvasImg" + pageNum;
				container.appendChild(canvas);

				// 页面渲染完成后，检查是否需要清理内存
				if (self.loadedPages && self.loadedPages.size > self.maxMemoryPages) {
					// 延迟清理，避免影响当前渲染
					setTimeout(function () {
						self.forceCleanupMemory();
					}, 100);
				}

				// 标记页面为已加载
				self.cache[pageNum + ""].loaded = true;
				self.cache[pageNum + ""].page = page;
				self.cache[pageNum + ""].canvas = canvas;
				self.cache[pageNum + ""].scaledViewport = viewport;

				// 更新页面位置信息（懒加载需要）
				if (self.options.lazyLoad) {
					self.updatePagePositions();
				}

				// 渲染文本层（如果启用）
				if (self.options.textLayer) {
					// textLayer使用原始的scaledViewport，不需要调整
					self.renderTextLayer(page, pageNum, container, scaledViewport);
				}

				// 更新进度条（分段加载模式下不显示进度条）
				if (self.options.loadingBar && self.progress && !self.progressiveLoading) {
					self.progress.style.width = num * self.loadedCount + "%";
				}

				// 触发渲染事件
				var time = new Date().getTime();
				var totalTime = time - self.initTime; // 总耗时
				var pageTime = time - (self.pageRenderStartTimes[pageNum] || self.initTime); // 单页耗时

				var arr1 = self.eventType["render"];
				if (arr1 && arr1 instanceof Array) {
					for (var i = 0; i < arr1.length; i++) {
						arr1[i] && arr1[i].call(self, pageNum, pageTime, totalTime, container);
					}
				}

				// 检查是否所有页面都加载完成（分段加载模式下不触发）
				if (!self.progressiveLoading && self.loadedCount === self.totalNum) {
					self.finalRender(options);
				}
			});
		},


		// 渲染文本层 - 使用与Canvas完全相同的viewport
		renderTextLayer: function (page, pageNum, container, viewport, options) {
			var self = this;

			// 设置默认的options
			options = options || {};

			// 获取canvas尺寸（如果提供）
			var canvasWidth = options.canvasWidth;
			var canvasHeight = options.canvasHeight;

			// 验证参数
			if (!container || typeof container.querySelector !== 'function') {
				return;
			}

			// 检查是否已存在文本层
			var existingTextLayer = container.querySelector(".textLayer");
			if (existingTextLayer && !options.forceRerender) {
				return;
			}

			// 如果是强制重新渲染，移除现有的textLayer
			if (existingTextLayer && options.forceRerender) {
				existingTextLayer.remove();
			}

			// 创建文本层容器 - 使用与官方viewer.mjs完全一致的样式
			var textLayerDiv = document.createElement('div');
			textLayerDiv.setAttribute('class', 'textLayer');
			textLayerDiv.setAttribute('role', 'presentation');
			textLayerDiv.setAttribute('aria-label', 'Text layer');
			textLayerDiv.tabIndex = 0;

			textLayerDiv.style.setProperty('--scale-factor', viewport.scale);
			textLayerDiv.style.setProperty('--user-unit', '1');
			textLayerDiv.style.setProperty('--total-scale-factor', 'calc(var(--scale-factor) * var(--user-unit))');

			textLayerDiv.style.position = 'absolute';
			textLayerDiv.style.inset = '0';
			textLayerDiv.style.overflow = 'clip';
			textLayerDiv.style.opacity = '1';
			textLayerDiv.style.lineHeight = '1';
			textLayerDiv.style.userSelect = 'text';
			textLayerDiv.style.pointerEvents = 'auto';
			textLayerDiv.style.cursor = 'text';
			textLayerDiv.style.transformOrigin = '0 0';
			textLayerDiv.style.zIndex = '101';
			textLayerDiv.style.textAlign = 'initial';
			textLayerDiv.style.textSizeAdjust = 'none';
			textLayerDiv.style.forcedColorAdjust = 'none';

			container.appendChild(textLayerDiv);

			page.getTextContent({
				includeMarkedContent: true,
				disableNormalization: true
			}).then(function (textContent) {
				// 检查pdfjsLib是否可用
				if (!self.pdfjsLib || !self.pdfjsLib.TextLayer) {
					return;
				}

				// 注意：TextLayer内部会处理缩放，所以传递原始的viewport
				// 对于密码保护PDF，确保viewport与容器尺寸匹配
				var textLayerViewport = viewport;
				if (self.options.password && container.clientWidth > 0 && container.clientHeight > 0) {
					// 密码保护PDF重新加载后，需要重新计算viewport
					var containerWidth = container.clientWidth;
					var containerHeight = container.clientHeight;
					var scaleX = containerWidth / viewport.width;
					var scaleY = containerHeight / viewport.height;
					var scale = Math.min(scaleX, scaleY);

					// 创建新的viewport，确保与容器尺寸匹配
					textLayerViewport = page.getViewport({ scale: viewport.scale * scale });
				}

				var textLayer = new self.pdfjsLib.TextLayer({
					textContentSource: textContent,
					container: textLayerDiv,
					viewport: textLayerViewport,
					textDivs: [],
					textContentItemsStr: []
				});

				// 将textLayer对象存储到DOM元素上，方便后续访问
				textLayerDiv.textLayer = textLayer;

				// 渲染文本层
				textLayer.render().then(function () {

					// 根据pageContainer的实际尺寸来设置textLayer尺寸
					var containerWidth = container.clientWidth || container.offsetWidth;
					var containerHeight = container.clientHeight || container.offsetHeight;

					// 如果容器尺寸为0（初始渲染时），使用viewport尺寸
					if (containerWidth === 0 || containerHeight === 0) {
						var pageWidth = viewport.rawDims.pageWidth;
						var pageHeight = viewport.rawDims.pageHeight;
						var w = 'var(--total-scale-factor) * ' + pageWidth + 'px';
						var h = 'var(--total-scale-factor) * ' + pageHeight + 'px';
					} else {
						// 计算textLayer的缩放比例，确保完全显示在pageContainer内
						var scaleX = containerWidth / viewport.width;
						var scaleY = containerHeight / viewport.height;
						var scale = Math.min(scaleX, scaleY);

						// 计算缩放后的textLayer尺寸
						var scaledWidth = viewport.width * scale;
						var scaledHeight = viewport.height * scale;

						var w = scaledWidth + 'px';
						var h = scaledHeight + 'px';
					}

					textLayerDiv.style.width = w;
					textLayerDiv.style.height = h;

					// 移除手动transform，让CSS变量自动处理
					textLayerDiv.style.transform = 'none';
					textLayerDiv.style.transformOrigin = '0 0';

					// 使用与pageContainer相同的scale，确保textLayer与pageContainer完全一致
					// 从pageContainer获取--scale-factor值，确保一致性
					var containerScale = container.style.getPropertyValue('--scale-factor') || viewport.scale;
					textLayerDiv.style.setProperty('--scale-factor', containerScale);
					textLayerDiv.style.setProperty('--user-unit', '1');
					textLayerDiv.style.setProperty('--total-scale-factor', 'calc(var(--scale-factor) * var(--user-unit))');



					// 处理密码保护PDF的markedContent包装层
					// 移除class="markedContent"的包装，只保留role="presentation"的span
					var markedContentSpans = textLayerDiv.querySelectorAll('.markedContent');
					markedContentSpans.forEach(function (markedContentSpan) {
						// 获取所有子元素
						var children = Array.from(markedContentSpan.children);
						// 将子元素移动到父级
						children.forEach(function (child) {
							markedContentSpan.parentNode.insertBefore(child, markedContentSpan);
						});
						// 移除空的markedContent包装
						markedContentSpan.remove();
					});

					// 触发文本层渲染完成事件
					if (self.eventType && self.eventType["textlayerrendered"]) {
						var arr1 = self.eventType["textlayerrendered"];
						if (arr1 && arr1 instanceof Array) {
							for (var i = 0; i < arr1.length; i++) {
								arr1[i] && arr1[i].call(self, {
									source: self,
									pageNumber: pageNum,
									numTextDivs: textLayerDiv.children.length
								});
							}
						}
					}
				}).catch(function (error) {
					console.error('Text layer rendering error:', error);
				});
			}).catch(function (error) {
				console.error('Text content extraction error:', error);
			});
		},

		finalRender: function (options) {
			var time = new Date().getTime();
			var self = this;

			if (self.options.loadingBar && self.progress) {
				self.progress.style.width = "100%";
			}

			if (self.loadingBar) {
				setTimeout(function () {
					self.loadingBar.style.display = "none";
				}, 300);
			}

			self.endTime = time - self.initTime;

			// 触发完成事件
			var arr1 = self.eventType["complete"];
			if (arr1 && arr1 instanceof Array) {
				for (var i = 0; i < arr1.length; i++) {
					arr1[i] && arr1[i].call(self, "success", "pdf加载完成", self.endTime);
				}
			}
		},

		handleScroll: function () {
			// 原有的滚动处理逻辑
			var scrollTop = this.viewerContainer.scrollTop;
			var containerH = this.container.offsetHeight;
			var height = containerH * (1 / 3);

			// 触发滚动事件
			this.trigger('scroll', {
				scrollTop: scrollTop,
				currentNum: this.currentNum
			});

			if (scrollTop >= 150) {
				if (this.options.backTop) {
					this.backTop.style.display = "block";
				}
			} else {
				if (this.options.backTop) {
					this.backTop.style.display = "none";
				}
			}

			// 显示页码
			clearTimeout(this.timer);
			if (this.options.pageNum && this.pageNum) {
				this.pageNum.style.display = "block";
			}

			// 更新当前页码 - 修复懒加载模式下的页码计算
			if (this.viewerContainer) {
				this.pages = this.viewerContainer.querySelectorAll('.pageContainer');
			}

			if (this.pages) {
				this.pages.forEach(function (obj, index) {
					var rect = obj.getBoundingClientRect();
					var top = rect.top;
					var bottom = rect.bottom;
					if (top <= height && bottom > height) {
						// 获取页面的实际页码，而不是数组索引
						var pageNum = parseInt(obj.getAttribute('name').split('=')[1]) || (index + 1);
						if (this.options.pageNum) {
							this.pageNow.innerText = pageNum;
						}

						// 只有当页码真正改变时才更新和触发事件
						if (this.currentNum !== pageNum) {
							this.currentNum = pageNum;
							this.trigger('pageChanged', { pageNumber: pageNum });
						}
					}
				}.bind(this));
			}

			// 处理特殊情况 - 修复懒加载模式下的页码计算
			if (scrollTop === 0) {
				if (this.options.pageNum) {
					this.pageNow.innerText = 1;
				}
				if (this.currentNum !== 1) {
					this.currentNum = 1;
					this.trigger('pageChanged', { pageNumber: 1 });
				}
			} else {
				// 在懒加载模式下，只有在真正滚动到底部且最后一页已渲染时才显示最后一页
				var lastPageContainer = this.viewerContainer.querySelector('.pageContainer[name="page=' + this.totalNum + '"]');
				if (lastPageContainer && this.cache[this.totalNum + ""].loaded) {
					var lastRect = lastPageContainer.getBoundingClientRect();
					var viewerRect = this.viewerContainer.getBoundingClientRect();

					// 更严格的检查：最后一页必须完全在视口内，且滚动位置接近底部
					var isLastPageVisible = lastRect.bottom <= viewerRect.bottom && lastRect.top >= viewerRect.top;
					var isNearBottom = scrollTop + this.container.offsetHeight >= this.viewer.offsetHeight - 100; // 100px容差
					var isLastPageLoaded = this.cache[this.totalNum + ""].loaded;

					// 只有在所有条件都满足时才显示最后一页
					if (isLastPageVisible && isNearBottom && isLastPageLoaded) {
						// 添加额外的检查：确保没有其他页面在视口内
						var hasOtherPagesInView = false;
						for (var i = 1; i < this.totalNum; i++) {
							var otherPage = this.viewerContainer.querySelector('.pageContainer[name="page=' + i + '"]');
							if (otherPage && this.cache[i + ""].loaded) {
								var otherRect = otherPage.getBoundingClientRect();
								if (otherRect.bottom > viewerRect.top && otherRect.top < viewerRect.bottom) {
									hasOtherPagesInView = true;
									break;
								}
							}
						}

						if (!hasOtherPagesInView) {
							if (this.options.pageNum) {
								this.pageNow.innerText = this.totalNum;
							}
							if (this.currentNum !== this.totalNum) {
								this.currentNum = this.totalNum;
								this.trigger('pageChanged', { pageNumber: this.totalNum });
							}
						}
					}
				}
			}

			// 自动隐藏页码
			this.timer = setTimeout(function () {
				if (this.options.pageNum && this.pageNum) {
					this.pageNum.style.display = "none";
				}
			}.bind(this), 1500);
		},

		scrollToTop: function () {
			this.viewerContainer.scrollTo({
				top: 0,
				behavior: "smooth"
			});
		},

		// 滚动到指定页面
		scrollToPage: function (pageNum) {
			var self = this;
			if (pageNum < 1 || pageNum > self.totalNum) {
				return;
			}

			// 确保页面已加载
			if (!self.cache[pageNum + ""].loaded) {
				// 如果页面未加载，先加载它
				self.renderPageLazy(self.thePDF, pageNum, self.options);
			}

			// 计算页面位置并滚动
			setTimeout(function () {
				var container = self.cache[pageNum + ""].container;
				if (container) {
					var containerRect = container.getBoundingClientRect();
					var viewerRect = self.viewerContainer.getBoundingClientRect();
					var scrollTop = self.viewerContainer.scrollTop;

					// 计算页面相对于滚动容器的位置
					var pageTop = containerRect.top - viewerRect.top + scrollTop;

					// 滚动到页面顶部
					self.viewerContainer.scrollTo({
						top: pageTop,
						behavior: "smooth"
					});

					// 更新当前页码
					self.currentNum = pageNum;
					if (self.options.pageNum) {
						self.pageNow.innerText = pageNum;
					}
				}
			}, 50);
		},

		// 保持原有的其他方法...
		show: function (callback) {
			this.container.style.display = "block";
			callback && callback.call(this);
		},

		hide: function (callback) {
			this.container.style.display = "none";
			callback && callback.call(this);
		},

		on: function (type, callback) {
			if (this.eventType[type] && this.eventType[type] instanceof Array) {
				this.eventType[type].push(callback);
			} else {
				this.eventType[type] = [callback];
			}
		},

		off: function (type) {
			if (type !== undefined) {
				this.eventType[type] = [null];
			} else {
				for (var i in this.eventType) {
					this.eventType[i] = [null];
				}
			}
		},

		trigger: function (event, data) {
			if (this.eventType[event]) {
				this.eventType[event].forEach(function (callback) {
					callback(data);
				});
			}
		},



		// 创建注释编辑器层
		createAnnotationEditorLayer: function (pageNum) {
			var self = this;

			if (!self.annotationEditorUIManager) {
				return;
			}

			try {
				// 检查页面缓存是否存在
				if (!self.cache || !self.cache[pageNum + ""]) {
					return;
				}

				// 获取页面容器
				var pageContainer = self.cache[pageNum + ""].container;
				if (!pageContainer) {
					return;
				}

				// 创建注释编辑器层div
				var editorLayerDiv = document.createElement('div');
				editorLayerDiv.className = 'annotationEditorLayer';
				editorLayerDiv.style.position = 'absolute';
				editorLayerDiv.style.top = '0';
				editorLayerDiv.style.left = '0';
				editorLayerDiv.style.width = '100%';
				editorLayerDiv.style.height = '100%';
				editorLayerDiv.style.pointerEvents = 'none';
				editorLayerDiv.style.zIndex = '1000';

				// 添加到页面容器
				pageContainer.appendChild(editorLayerDiv);

				// 创建注释编辑器层
				var editorLayer = new self.pdfjsLib.AnnotationEditorLayer({
					uiManager: self.annotationEditorUIManager,
					div: editorLayerDiv,
					structTreeLayer: null,
					accessibilityManager: null,
					pageIndex: pageNum - 1,
					viewport: self.cache[pageNum + ""].scaledViewport
				});

				// 将注释编辑器层添加到AnnotationEditorUIManager
				self.annotationEditorUIManager.addLayer(editorLayer);

			} catch (error) {
			}
		},

		// 初始化手势缩放 - 使用老版本的PinchZoom实现
		initTouchManager: function () {
			var self = this;

			// 销毁现有的PinchZoom
			if (this.pinchZoom) {
				this.pinchZoom.destroy();
				this.pinchZoom = null;
			}

			// 确保viewerContainer存在
			if (!this.viewerContainer) {
				return;
			}

			// 创建新的PinchZoom - 使用老版本的实现
			this.pinchZoom = new PinchZoom(this.viewer, {
				tapZoomFactor: this.options.tapZoomFactor || 2,
				zoomOutFactor: this.options.zoomOutFactor || 1.2,
				animationDuration: this.options.animationDuration || 300,
				maxZoom: this.zoomConstraints.maxScale,
				minZoom: this.zoomConstraints.minScale
			}, this.viewerContainer);

			// 设置缩放完成回调
			var timeout, firstZoom = true;
			this.pinchZoom.done = function (scale) {
				clearTimeout(timeout);
				timeout = setTimeout(function () {
					// 更新缩放值
					self.scale = scale;

					// 智能更新策略：根据是否启用懒加载决定更新方式
					if (self.thePDF && self.container.pdfLoaded) {
						if (self.lazyLoad || self.progressiveLoading) {
							// 懒加载模式：只更新可见页面，避免重新加载所有页面
							self.updateVisiblePagesScale();
						} else {
							// 普通模式：更新所有页面
							self.updateAllPagesScale();
						}
					}

					// 触发缩放事件
					self.trigger('zoom', {
						scale: scale
					});
				}, 100); // 减少延迟时间，提高响应性

				if (scale == 1) {
					if (self.viewerContainer) {
						self.viewerContainer.style.webkitOverflowScrolling = "touch";
					}
				} else {
					if (self.viewerContainer) {
						self.viewerContainer.style.webkitOverflowScrolling = "auto";
					}
				}
			};
		},


		// 更新缩放 - 参考PDF.js官方实现
		updateZoom: function (newScale, origin) {
			var self = this;

			// 使用官方的方式设置CSS变量
			var PDF_TO_CSS_UNITS = 96.0 / 72.0;
			this.viewer.style.setProperty('--scale-factor', newScale * PDF_TO_CSS_UNITS);

			// 计算缩放中心点
			var centerX, centerY;
			if (origin && origin.length >= 2) {
				// 使用手势中心点
				centerX = origin[0];
				centerY = origin[1];
			} else {
				// 使用容器中心点
				centerX = this.viewerContainer.clientWidth / 2;
				centerY = this.viewerContainer.clientHeight / 2;
			}

			// 将屏幕坐标转换为相对于容器的坐标
			var containerRect = this.viewerContainer.getBoundingClientRect();
			var relativeX = centerX - containerRect.left;
			var relativeY = centerY - containerRect.top;

			// 应用缩放变换
			this.viewer.style.transform = 'scale(' + newScale + ')';
			this.viewer.style.transformOrigin = relativeX + 'px ' + relativeY + 'px';

			// 添加过渡效果，使缩放更平滑
			this.viewer.style.transition = 'transform 0.1s ease-out';

			// 重新渲染所有页面以应用新的缩放
			if (this.thePDF && this.container.pdfLoaded) {
				this.updateAllPagesScale();
			}

			// 触发缩放事件
			this.trigger('zoom', {
				scale: newScale,
				origin: origin,
				centerX: relativeX,
				centerY: relativeY
			});
		},

		// ==================== 缩放控制API ====================

		// 禁用/启用缩放手势
		setZoomEnabled: function (enabled) {
			this.zoomDisabled = !enabled;
			return this;
		},

		// 获取缩放状态
		isZoomEnabled: function () {
			return !this.zoomDisabled;
		},

		// 禁用/启用滚动
		setScrollEnabled: function (enabled) {
			this.scrollDisabled = !enabled;
			if (this.viewerContainer) {
				this.viewerContainer.style.overflow = enabled ? 'auto' : 'hidden';
			}
			return this;
		},

		// 获取滚动状态
		isScrollEnabled: function () {
			return !this.scrollDisabled;
		},

		// 设置缩放约束
		setZoomConstraints: function (constraints) {
			if (constraints.minScale !== undefined) {
				this.zoomConstraints.minScale = Math.max(0.1, constraints.minScale);
			}
			if (constraints.maxScale !== undefined) {
				this.zoomConstraints.maxScale = Math.min(20.0, constraints.maxScale);
			}
			if (constraints.step !== undefined) {
				this.zoomConstraints.step = Math.max(0.01, constraints.step);
			}
			return this;
		},

		// 获取缩放约束
		getZoomConstraints: function () {
			return Object.assign({}, this.zoomConstraints);
		},

		// 检查是否正在缩放
		isZooming: function () {
			return this.isZooming;
		},

		// ==================== 新增功能API ====================

		// 页面跳转功能API
		goToPage: function (pageNum) {
			var self = this;
			if (pageNum < 1 || pageNum > self.totalNum) {
				return false;
			}

			self.currentNum = pageNum;

			// 滚动到指定页面
			var pageContainer = null;

			// 分段加载模式：使用loadedPages
			if (self.progressiveLoading && self.loadedPages.has(pageNum)) {
				var pageData = self.loadedPages.get(pageNum);
				pageContainer = pageData.container;
			}
			// 传统模式：使用cache
			else if (self.cache[pageNum + ""]) {
				pageContainer = self.cache[pageNum + ""].container;
			}

			// 如果页面未加载，先加载页面
			if (!pageContainer) {
				if (self.progressiveLoading) {
					// 分段加载模式：异步加载页面
					self.loadPageProgressive(pageNum, self.options).then(function () {
						// 页面加载完成后滚动
						setTimeout(function () {
							self.scrollToPage(pageNum);
						}, 100);
					});
				} else {
					// 传统模式：直接渲染页面
					self.renderPage(self.thePDF.getPage(pageNum), pageNum, self.options);
					setTimeout(function () {
						self.scrollToPage(pageNum);
					}, 100);
				}
			} else {
				// 页面已加载，直接滚动
				pageContainer.scrollIntoView({
					behavior: 'smooth',
					block: 'start'
				});
			}

			self.trigger('pageChanged', { pageNumber: pageNum });
			return true;
		},

		nextPage: function () {
			var self = this;
			if (self.currentNum < self.totalNum) {
				return self.goToPage(self.currentNum + 1);
			}
			return false;
		},

		prevPage: function () {
			var self = this;
			if (self.currentNum > 1) {
				return self.goToPage(self.currentNum - 1);
			}
			return false;
		},

		// 缩放功能API
		zoomIn: function () {
			var self = this;
			if (!self.thePDF) {
				console.warn('No PDF loaded');
				return false;
			}

			// 防抖机制
			if (self.zoomTimeout) {
				clearTimeout(self.zoomTimeout);
			}

			var newScale = Math.min(self.scale * 1.2, 4.0);
			self.zoomTimeout = setTimeout(function () {
				self.setScale(newScale);
			}, 100);

			return true;
		},

		zoomOut: function () {
			var self = this;
			if (!self.thePDF) {
				console.warn('No PDF loaded');
				return false;
			}

			// 防抖机制
			if (self.zoomTimeout) {
				clearTimeout(self.zoomTimeout);
			}

			var newScale = Math.max(self.scale / 1.2, 0.25);
			self.zoomTimeout = setTimeout(function () {
				self.setScale(newScale);
			}, 100);

			return true;
		},

		setScale: function (scale) {
			var self = this;
			if (!self.thePDF) {
				console.warn('No PDF loaded');
				return false;
			}

			if (typeof scale === 'string') {
				// 处理特殊缩放模式
				switch (scale) {
					case 'auto':
						scale = 1.0;
						break;
					case 'page-actual':
						scale = 1.0;
						break;
					case 'page-fit':
						// 使用PDF页面的实际尺寸计算缩放
						var pageWidth = self.docWidth; // 这里应该使用PDF页面的实际宽度
						scale = self.viewer.clientWidth / pageWidth;
						break;
					case 'page-width':
						// 使用PDF页面的实际尺寸计算缩放
						var pageWidth = self.docWidth; // 这里应该使用PDF页面的实际宽度
						scale = self.viewer.clientWidth / pageWidth;
						break;
					default:
						// 处理百分比字符串，如 "200%" -> 2.0
						if (scale.includes('%')) {
							scale = parseFloat(scale) / 100;
						} else {
							scale = parseFloat(scale) || 1.0;
						}
				}
			}

			// 使用配置的缩放约束
			var minScale = this.zoomConstraints.minScale || 0.5;
			var maxScale = this.zoomConstraints.maxScale || 4.0;
			self.scale = Math.max(minScale, Math.min(maxScale, scale));

			// 触发缩放事件
			self.trigger('scaleChanged', { scale: self.scale });

			// 重新渲染已加载的页面
			if (self.thePDF) {
				for (var i = 1; i <= self.totalNum; i++) {
					if (self.cache[i + ""].loaded) {
						self.thePDF.getPage(i).then(function (page) {
							var pageNum = page.pageNumber;
							// 使用与官方viewer.mjs相同的缩放因子
							var PDF_TO_CSS_UNITS = 96.0 / 72.0;
							var scaledViewport = page.getViewport({ scale: self.scale * PDF_TO_CSS_UNITS });

							var container = self.cache[pageNum + ""].container;
							if (container) {
								// 更新容器尺寸

								// 更新CSS变量
								container.style.setProperty('--scale-factor', scaledViewport.scale);

								// 重新渲染Canvas - 创建新的Canvas避免重复渲染错误
								var canvas = container.querySelector('canvas');
								if (canvas) {
									// 取消之前的渲染任务
									if (self.cache[pageNum + ""].renderTask) {
										self.cache[pageNum + ""].renderTask.cancel();
									}

									// 创建新的Canvas避免重复渲染
									var newCanvas = document.createElement('canvas');
									newCanvas.width = scaledViewport.width;
									newCanvas.height = scaledViewport.height;
									newCanvas.style.width = scaledViewport.width + 'px';
									newCanvas.style.height = scaledViewport.height + 'px';

									// 替换旧的Canvas
									canvas.parentNode.replaceChild(newCanvas, canvas);

									var enableHWA = self.options.enableHWA !== false;
									var renderObj = {
										canvasContext: newCanvas.getContext('2d', {
											alpha: false,
											willReadFrequently: !enableHWA
										}),
										viewport: scaledViewport
									};

									// 存储渲染任务以便后续取消
									self.cache[pageNum + ""].renderTask = page.render(renderObj);
								}

								// 重新渲染文本层
								var textLayer = container.querySelector('.textLayer');
								if (textLayer) {
									textLayer.innerHTML = '';
									self.renderTextLayer(page, pageNum, container, scaledViewport);
								}
							}
						});
					}
				}
			}

			self.trigger('zoom', { scale: self.scale });
			return true;
		},

		// 搜索功能API
		searchText: function (query) {
			var self = this;
			if (!self.thePDF || !query) {
				return false;
			}

			// 简单的文本搜索实现
			self.currentSearchQuery = query;
			self.searchResults = [];

			// 遍历所有页面进行搜索
			for (var i = 1; i <= self.totalNum; i++) {
				var pageContainer = self.cache[i + ""];
				if (pageContainer && pageContainer.container) {
					var textLayer = pageContainer.container.querySelector('.textLayer');
					if (textLayer) {
						var text = textLayer.textContent.toLowerCase();
						var queryLower = query.toLowerCase();
						if (text.includes(queryLower)) {
							self.searchResults.push(i);
						}
					}
				}
			}

			self.trigger('search', {
				query: query,
				results: self.searchResults,
				totalResults: self.searchResults.length
			});

			return self.searchResults.length > 0;
		},

		clearSearch: function () {
			var self = this;
			self.currentSearchQuery = null;
			self.searchResults = [];
			self.currentSearchIndex = 0;

			// 清除高亮
			var textLayers = self.container.querySelectorAll('.textLayer');
			textLayers.forEach(function (layer) {
				var highlights = layer.querySelectorAll('.highlight');
				highlights.forEach(function (highlight) {
					highlight.classList.remove('highlight');
				});
			});

			self.trigger('searchCleared');
		},

		findNext: function () {
			var self = this;
			if (!self.searchResults || self.searchResults.length === 0) {
				return false;
			}

			self.currentSearchIndex = (self.currentSearchIndex + 1) % self.searchResults.length;
			var pageNum = self.searchResults[self.currentSearchIndex];
			self.goToPage(pageNum);

			self.trigger('findNext', {
				pageNumber: pageNum,
				index: self.currentSearchIndex,
				total: self.searchResults.length
			});

			return true;
		},

		findPrevious: function () {
			var self = this;
			if (!self.searchResults || self.searchResults.length === 0) {
				return false;
			}

			self.currentSearchIndex = self.currentSearchIndex === 0 ?
				self.searchResults.length - 1 : self.currentSearchIndex - 1;
			var pageNum = self.searchResults[self.currentSearchIndex];
			self.goToPage(pageNum);

			self.trigger('findPrevious', {
				pageNumber: pageNum,
				index: self.currentSearchIndex,
				total: self.searchResults.length
			});

			return true;
		},

		// 打印功能API - 参考PDF.js官方实现
		printPDF: function () {
			var self = this;
			if (!self.thePDF) {
				console.warn('No PDF loaded');
				return false;
			}

			// 触发打印事件
			self.trigger('print');

			// 创建打印容器
			var printContainer = document.createElement('div');
			printContainer.id = 'pdfh5-print-container';
			printContainer.style.position = 'absolute';
			printContainer.style.left = '-9999px';
			printContainer.style.top = '-9999px';
			printContainer.style.width = '210mm'; // A4宽度
			printContainer.style.height = '297mm'; // A4高度
			printContainer.style.background = 'white';
			printContainer.style.padding = '0';
			printContainer.style.margin = '0';

			// 添加打印样式
			var printStyle = document.createElement('style');
			printStyle.textContent = `
				@media print {
					body * { visibility: hidden; }
					#pdfh5-print-container, #pdfh5-print-container * { visibility: visible; }
					#pdfh5-print-container { position: absolute; left: 0; top: 0; width: 100%; }
				}
			`;
			document.head.appendChild(printStyle);
			document.body.appendChild(printContainer);

			// 渲染所有页面到打印容器
			self.renderPagesForPrint(printContainer).then(function () {
				// 延迟打印，确保页面渲染完成
				setTimeout(function () {
					window.print();

					// 清理打印容器
					setTimeout(function () {
						if (printContainer.parentNode) {
							printContainer.parentNode.removeChild(printContainer);
						}
						if (printStyle.parentNode) {
							printStyle.parentNode.removeChild(printStyle);
						}
					}, 1000);
				}, 500);
			}).catch(function (error) {
				console.error('Print rendering failed:', error);
				// 清理打印容器
				if (printContainer.parentNode) {
					printContainer.parentNode.removeChild(printContainer);
				}
				if (printStyle.parentNode) {
					printStyle.parentNode.removeChild(printStyle);
				}
			});

			return true;
		},

		// 为打印渲染页面
		renderPagesForPrint: function (printContainer) {
			var self = this;
			var promises = [];

			// 为每一页创建打印内容
			for (var i = 1; i <= self.totalNum; i++) {
				promises.push(self.renderPageForPrint(i, printContainer));
			}

			return Promise.all(promises);
		},

		// 渲染单页用于打印
		renderPageForPrint: function (pageNum, printContainer) {
			var self = this;

			return self.thePDF.getPage(pageNum).then(function (page) {
				// 使用适合打印的缩放比例
				var viewport = page.getViewport({ scale: 1.5 });

				// 创建页面容器
				var pageContainer = document.createElement('div');
				pageContainer.style.width = viewport.width + 'px';
				pageContainer.style.height = viewport.height + 'px';
				pageContainer.style.margin = '0 auto 10px auto';
				pageContainer.style.pageBreakAfter = 'always';
				pageContainer.style.background = 'white';
				pageContainer.style.boxShadow = '0 0 10px rgba(0,0,0,0.1)';

				// 创建canvas
				var canvas = document.createElement('canvas');
				// 打印时使用标准像素比
				canvas.width = viewport.width;
				canvas.height = viewport.height;
				canvas.style.width = '100%';
				canvas.style.height = '100%';

				pageContainer.appendChild(canvas);
				printContainer.appendChild(pageContainer);

				// 渲染页面
				var enableHWA = self.options.enableHWA !== false;
				var renderContext = {
					canvasContext: canvas.getContext('2d', {
						alpha: false,
						willReadFrequently: !enableHWA
					}),
					viewport: viewport
				};

				return page.render(renderContext).promise;
			});
		},

		// 渐进式加载初始化
		initProgressiveLoading: function (pdf, options) {
			var self = this;

			// 初始化缓存
			for (var i = 1; i <= self.totalNum; i++) {
				self.cache[i + ""] = {
					page: null,
					loaded: false,
					container: null,
					scaledViewport: null,
					canvas: null,
					imgWidth: null
				};
			}

			// 预计算所有页面尺寸，然后创建容器
			self.preCalculateAllPageSizes(pdf, options).then(function () {
				// 使用预计算的尺寸创建页面容器占位符
				for (var i = 1; i <= self.totalNum; i++) {
					self.createPageContainerWithPreCalculatedSize(i, options);
				}

				// 继续原有的分段加载逻辑
				self.continueProgressiveLoading(pdf, options);
			});
		},

		// 分段加载模式下隐藏loadingBar
		hideLoadingBarForProgressiveLoading: function () {
			var self = this;

			// 设置进度条为100%
			if (self.options.loadingBar && self.progress) {
				self.progress.style.width = "100%";
			}

			// 延迟隐藏loadingBar，确保用户能看到100%的进度
			if (self.loadingBar) {
				setTimeout(function () {
					self.loadingBar.style.display = "none";

					// 触发分段加载完成事件
					var time = new Date().getTime();
					self.endTime = time - self.initTime;

					// 触发完成事件
					var arr1 = self.eventType["complete"];
					if (arr1 && arr1 instanceof Array) {
						for (var i = 0; i < arr1.length; i++) {
							arr1[i] && arr1[i].call(self, "success", "pdf分段加载初始化完成", self.endTime);
						}
					}
				}, 300);
			}
		},

		// 继续分段加载逻辑
		continueProgressiveLoading: function (pdf, options) {
			var self = this;

			// 检查是否有goto配置
			if (self.options.goto && self.options.goto > 0 && self.options.goto <= self.totalNum) {
				self.currentNum = self.options.goto;
			}

			// 分段加载模式下隐藏loadingBar
			self.hideLoadingBarForProgressiveLoading();

			// 先加载前几页，优先加载goto页面
			var initialPages = Math.min(self.maxMemoryPages, self.totalNum);
			var pagesToLoad = [];

			// 如果有goto配置，优先加载goto页面及其周围页面
			if (self.options.goto && self.options.goto > 0) {
				var gotoPage = self.options.goto;
				pagesToLoad.push(gotoPage);

				// 加载goto页面周围的页面
				for (var i = 1; i <= initialPages; i++) {
					if (i !== gotoPage && Math.abs(i - gotoPage) <= Math.floor(initialPages / 2)) {
						pagesToLoad.push(i);
					}
				}
			} else {
				// 没有goto配置，只加载第一页
				pagesToLoad.push(1);
			}


			// 加载页面
			pagesToLoad.forEach(function (pageNum) {
				self.loadPageProgressive(pageNum, options);
			});

			// 设置滚动监听，动态加载页面
			self.setupProgressiveScrollListener(options);

			// 初始化TouchManager - 手势缩放
			if (self.options.zoomEnable) {
				self.initTouchManager();
			}

			// 延迟检查内存使用情况，确保内存管理正常工作
			setTimeout(function () {
				if (self.loadedPages.size > self.maxMemoryPages) {
					self.cleanupDistantPages(self.currentNum);
				}
			}, 1000);

			// 如果有goto配置，延迟滚动到指定页面
			if (self.options.goto && self.options.goto > 1) {
				setTimeout(function () {
					self.scrollToPage(self.options.goto);
				}, 200); // 稍微延迟，确保页面已加载
			}
		},

		// 渐进式页面加载
		loadPageProgressive: function (pageNum, options) {
			var self = this;

			// 检查是否已加载
			if (self.loadedPages.has(pageNum)) {
				return Promise.resolve();
			}

			// 限制同时加载的页面数量
			if (self.loadingQueue.length >= 2) {
				return Promise.resolve();
			}

			// 强制内存管理：如果超过最大页面数，清理最远的页面
			if (self.loadedPages.size >= self.maxMemoryPages) {
				self.cleanupDistantPages(pageNum);
			}

			// 添加到加载队列
			self.loadingQueue.push(pageNum);

			// 使用现有的renderPageLazy方法
			return self.renderPageLazy(self.thePDF, pageNum, options).then(function () {
				// 标记为已加载
				self.loadedPages.set(pageNum, {
					page: self.cache[pageNum + ""].page,
					loaded: true,
					loadTime: new Date().getTime(),
					container: self.cache[pageNum + ""].container
				});

				// 从队列中移除
				var index = self.loadingQueue.indexOf(pageNum);
				if (index > -1) {
					self.loadingQueue.splice(index, 1);
				}

				// 加载完成后再次检查内存使用情况
				if (self.loadedPages.size > self.maxMemoryPages) {
					self.cleanupDistantPages(pageNum);
				}

				// 触发页面加载完成事件
				self.trigger('pageLoaded', {
					pageNum: pageNum,
					memoryUsage: self.getMemoryUsage()
				});
			}).catch(function (error) {
				console.error('分段加载 - 页面加载失败:', pageNum, error);
			});
		},

		// 设置渐进式滚动监听
		setupProgressiveScrollListener: function (options) {
			var self = this;

			// 使用Intersection Observer监听页面可见性
			if (self.intersectionObserver) {
				self.intersectionObserver.disconnect();
			}

			self.intersectionObserver = new IntersectionObserver(function (entries) {
				entries.forEach(function (entry) {
					if (entry.isIntersecting) {
						var pageNum = parseInt(entry.target.getAttribute('data-page'));
						var intersectionRatio = entry.intersectionRatio;

						// 只有当页面真正可见时才加载（可见比例大于0.3）
						if (pageNum && !self.loadedPages.has(pageNum) && intersectionRatio > 0.3) {
							self.loadPageProgressive(pageNum, options);
						}
					}
				});
			}, {
				rootMargin: '0px', // 不提前加载
				threshold: [0.3, 0.5, 1.0] // 提高可见性阈值
			});

			// 监听所有页面容器
			for (var i = 1; i <= self.totalNum; i++) {
				var container = self.cache[i + ""].container;
				if (container) {
					self.intersectionObserver.observe(container);
				}
			}

			// 添加滚动事件监听器，在滚动时自动清理内存
			if (self.scrollListener) {
				self.viewerContainer.removeEventListener('scroll', self.scrollListener);
			}

			self.scrollListener = function () {
				// 延迟执行，避免频繁清理
				clearTimeout(self.scrollTimeout);
				self.scrollTimeout = setTimeout(function () {
					if (self.loadedPages.size > self.maxMemoryPages) {
						self.forceCleanupMemory();
					}
				}, 500); // 500ms延迟
			};

			self.viewerContainer.addEventListener('scroll', self.scrollListener);
		},

		// 清理远距离页面
		cleanupDistantPages: function (currentPage) {
			var self = this;
			var pagesToRemove = [];

			// 如果已加载页面数超过最大限制，清理最远的页面
			if (self.loadedPages.size >= self.maxMemoryPages) {
				// 按距离排序，保留最近的页面
				var sortedPages = Array.from(self.loadedPages.keys()).sort(function (a, b) {
					return Math.abs(a - currentPage) - Math.abs(b - currentPage);
				});

				// 保留最近的maxMemoryPages个页面，清理其余的
				var pagesToKeep = sortedPages.slice(0, self.maxMemoryPages);
				sortedPages.forEach(function (pageNum) {
					if (pagesToKeep.indexOf(pageNum) === -1) {
						pagesToRemove.push(pageNum);
					}
				});

			}

			// 清理页面
			pagesToRemove.forEach(function (pageNum) {
				self.cleanupPage(pageNum);
			});
		},

		// 清理单个页面
		cleanupPage: function (pageNum) {
			var self = this;
			var container = self.cache[pageNum + ""].container;

			if (container) {
				// 只清理canvas和文本层，保留容器占位
				var canvas = container.querySelector('canvas');
				var textLayer = container.querySelector('.textLayer');

				if (canvas) {
					// 清空canvas内容
					var enableHWA = self.options.enableHWA !== false;
					var ctx = canvas.getContext('2d', {
						alpha: false,
						willReadFrequently: !enableHWA
					});
					ctx.clearRect(0, 0, canvas.width, canvas.height);
					canvas.width = 0;
					canvas.height = 0;
					canvas.remove();
				}
				if (textLayer) {
					textLayer.innerHTML = '';
					textLayer.remove();
				}


				// 从缓存中移除
				self.loadedPages.delete(pageNum);

				// 从加载状态中移除（如果存在）
				if (self.loadingPages) {
					self.loadingPages.delete(pageNum);
				}

				// 重置缓存状态
				if (self.cache[pageNum + ""]) {
					self.cache[pageNum + ""].loaded = false;
					self.cache[pageNum + ""].canvas = null;
					self.cache[pageNum + ""].page = null;
				}

				// 触发页面清理事件
				self.trigger('pageCleaned', {
					pageNum: pageNum,
					memoryUsage: self.getMemoryUsage()
				});
			}
		},

		// 获取内存使用情况
		getMemoryUsage: function () {
			var self = this;
			var usage = {
				loadedPages: self.loadedPages.size,
				maxPages: self.maxMemoryPages,
				loadingQueue: self.loadingQueue.length,
				memoryUsage: self.memoryUsage
			};
			return usage;
		},

		// 强制清理内存
		forceCleanupMemory: function () {
			var self = this;

			// 获取当前可见的页面
			var visiblePages = [];
			for (var i = 1; i <= self.totalNum; i++) {
				var container = self.cache[i + ""].container;
				if (container) {
					var rect = container.getBoundingClientRect();
					var viewerRect = self.viewerContainer.getBoundingClientRect();

					// 检查页面是否在视口内（更严格的检查）
					var isVisible = rect.bottom > viewerRect.top &&
						rect.top < viewerRect.bottom &&
						rect.width > 0 &&
						rect.height > 0;

					if (isVisible) {
						visiblePages.push(i);
					}
				}
			}

			// 如果已加载页面数超过限制，清理最远的页面
			if (self.loadedPages.size > self.maxMemoryPages) {
				// 按距离当前可见页面中心的距离排序
				var centerPage = visiblePages.length > 0 ?
					visiblePages[Math.floor(visiblePages.length / 2)] :
					self.currentNum;

				var sortedPages = Array.from(self.loadedPages.keys()).sort(function (a, b) {
					return Math.abs(a - centerPage) - Math.abs(b - centerPage);
				});

				// 保留最近的maxMemoryPages个页面
				var pagesToKeep = sortedPages.slice(0, self.maxMemoryPages);
				var pagesToRemove = [];

				sortedPages.forEach(function (pageNum) {
					if (pagesToKeep.indexOf(pageNum) === -1) {
						pagesToRemove.push(pageNum);
					}
				});

				// 清理页面
				pagesToRemove.forEach(function (pageNum) {
					self.cleanupPage(pageNum);
				});
			}
		},

		// 设置分段加载配置
		setProgressiveLoading: function (enabled, options) {
			this.progressiveLoading = enabled;
			if (options) {
				if (options.chunkSize) this.chunkSize = options.chunkSize;
				if (options.maxMemoryPages) this.maxMemoryPages = options.maxMemoryPages;
			}
			return this;
		},

		// 获取分段加载状态
		getProgressiveLoadingStatus: function () {
			return {
				enabled: this.progressiveLoading,
				chunkSize: this.chunkSize,
				maxMemoryPages: this.maxMemoryPages,
				loadedPages: this.loadedPages.size,
				loadingQueue: this.loadingQueue.length,
				memoryUsage: this.getMemoryUsage()
			};
		},

		// 下载功能API
		downloadPDF: function (filename) {
			var self = this;
			if (!self.thePDF) {
				console.warn('No PDF loaded');
				return Promise.reject('No PDF loaded');
			}

			// 如果没有提供文件名，尝试从PDF URL中提取文件名
			if (!filename) {
				if (self.options.pdfurl) {
					// 从URL中提取文件名
					var urlParts = self.options.pdfurl.split('/');
					var urlFilename = urlParts[urlParts.length - 1];

					// 如果URL中有查询参数，需要去掉
					if (urlFilename.includes('?')) {
						urlFilename = urlFilename.split('?')[0];
					}

					// 如果提取到的文件名有效，使用它；否则使用默认名称
					if (urlFilename && urlFilename.includes('.pdf')) {
						filename = urlFilename;
					} else {
						filename = 'document.pdf';
					}
				} else {
					filename = 'document.pdf';
				}
			}

			return self.getPDFWithAnnotations().then(function (pdfData) {

				var blob = new Blob([pdfData], { type: 'application/pdf' });
				var url = URL.createObjectURL(blob);

				var a = document.createElement('a');
				a.href = url;
				a.download = filename;
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
				URL.revokeObjectURL(url);

				self.trigger('download', { url: url, filename: filename });
				return { url: url, filename: filename };
			});
		},

		getPDFWithAnnotations: function () {
			var self = this;

			return new Promise(function (resolve, reject) {
				if (!self.thePDF) {
					reject('No PDF loaded');
					return;
				}

				// 检查是否有图章或墨迹注释需要保存
				var stampAnnotations = self.editorAnnotations.filter(function (ann) {
					return ann.type === 'STAMP';
				});

				var inkAnnotations = self.editorAnnotations.filter(function (ann) {
					return ann.type === 'INK';
				});

				if (stampAnnotations.length > 0 || inkAnnotations.length > 0) {

					// 使用PDF.js官方的saveDocument方法
					if (self.thePDF.saveDocument) {
						try {
							// 确保注释存储已修改
							if (self.thePDF.annotationStorage) {
								self.thePDF.annotationStorage.setModified(true);
							}

							self.thePDF.saveDocument().then(function (pdfData) {
								resolve(pdfData);
							}).catch(function (error) {
								console.error('使用PDF.js saveDocument失败:', error.message);

								// 如果saveDocument失败，回退到原始PDF
								fetch(self.options.pdfurl)
									.then(function (response) {
										return response.arrayBuffer();
									})
									.then(function (data) {
										console.warn('注意：返回的PDF不包含注释');
										resolve(data);
									})
									.catch(reject);
							});
						} catch (error) {
							console.error('保存PDF时发生错误:', error.message);
							// 回退到原始PDF
							if (self.options.pdfurl) {
								fetch(self.options.pdfurl)
									.then(function (response) {
										return response.arrayBuffer();
									})
									.then(function (data) {
										console.warn('注意：返回的PDF不包含注释');
										resolve(data);
									})
									.catch(reject);
							} else if (self.options.data) {
								// 如果使用data配置，直接使用原始数据
								console.warn('注意：返回的PDF不包含注释');
								resolve(self.options.data);
							} else {
								reject('无法获取PDF数据');
							}
						}
					} else {
						// 如果没有saveDocument方法，回退到原始PDF
						if (self.options.pdfurl) {
							fetch(self.options.pdfurl)
								.then(function (response) {
									return response.arrayBuffer();
								})
								.then(function (data) {
									console.warn('注意：返回的PDF不包含注释');
									resolve(data);
								})
								.catch(reject);
						} else if (self.options.data) {
							// 如果使用data配置，直接使用原始数据
							console.warn('注意：返回的PDF不包含注释');
							resolve(self.options.data);
						} else {
							reject('无法获取PDF数据');
						}
					}
				} else {
					// 没有注释，直接返回原始PDF数据
					if (self.options.pdfurl) {
						fetch(self.options.pdfurl)
							.then(function (response) {
								return response.arrayBuffer();
							})
							.then(function (data) {
								resolve(data);
							})
							.catch(reject);
					} else if (self.options.data) {
						// 如果使用data配置，直接使用原始数据
						resolve(self.options.data);
					} else {
						reject('无法获取PDF数据');
					}
				}
			});
		},

		// 使用PDF-lib库保存注释到PDF
		savePDFWithAnnotations: async function (annotations) {
			var self = this;

			// 检查PDF-lib是否可用
			if (typeof PDFLib === 'undefined') {
				throw new Error('PDF-lib库未加载，请在HTML中引入：<script src="https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js"></script>');
			}

			// 1. 获取原始PDF数据
			const response = await fetch(self.options.pdfurl);
			const pdfData = await response.arrayBuffer();

			// 2. 加载PDF文档
			const pdfDoc = await PDFLib.PDFDocument.load(pdfData);

			// 3. 遍历所有注释
			for (const annotation of annotations) {
				const page = pdfDoc.getPage(annotation.pageNum - 1);
				const pageHeight = page.getHeight();

				if (annotation.type === 'STAMP') {
					// 处理图章注释
					if (annotation.imageData) {
						// 将base64图片转换为ArrayBuffer
						const imageDataUrl = annotation.imageData;
						const imageBytes = await fetch(imageDataUrl).then(r => r.arrayBuffer());

						// 根据图片类型嵌入图片
						let image;
						if (imageDataUrl.startsWith('data:image/png')) {
							image = await pdfDoc.embedPng(imageBytes);
						} else if (imageDataUrl.startsWith('data:image/jpeg') || imageDataUrl.startsWith('data:image/jpg')) {
							image = await pdfDoc.embedJpg(imageBytes);
						} else {
							console.warn('不支持的图片格式，跳过:', imageDataUrl.substring(0, 30));
							continue;
						}

						// 计算PDF坐标（PDF坐标系原点在左下角）
						const pdfY = pageHeight - annotation.y - annotation.height;

						// 添加图章到页面
						page.drawImage(image, {
							x: annotation.x,
							y: pdfY,
							width: annotation.width,
							height: annotation.height,
						});

					}
				} else if (annotation.type === 'INK') {
					// 处理墨迹注释
					if (annotation.path && annotation.path.length > 1) {
						// 构建SVG路径字符串
						let pathData = `M ${annotation.path[0].x} ${pageHeight - annotation.path[0].y}`;
						for (let i = 1; i < annotation.path.length; i++) {
							const pdfY = pageHeight - annotation.path[i].y;
							pathData += ` L ${annotation.path[i].x} ${pdfY}`;
						}

						// 解析颜色
						const color = annotation.color || '#000000';
						const r = parseInt(color.substring(1, 3), 16) / 255;
						const g = parseInt(color.substring(3, 5), 16) / 255;
						const b = parseInt(color.substring(5, 7), 16) / 255;

						// 绘制墨迹路径
						page.drawSvgPath(pathData, {
							borderColor: PDFLib.rgb(r, g, b),
							borderWidth: annotation.thickness || 1,
							borderOpacity: annotation.opacity || 1
						});

					}
				}
			}

			// 4. 保存PDF
			const pdfBytes = await pdfDoc.save();

			return pdfBytes;
		},

		// 获取当前状态
		getStatus: function () {
			var self = this;
			return {
				version: self.version,
				totalPages: self.totalNum,
				currentPage: self.currentNum,
				scale: self.scale,
				loadedPages: self.loadedCount
			};
		},

		// 更新注释（当用户调整图章大小时）
		updateAnnotation: function (annotationId, updates) {
			var self = this;

			// 更新前端显示
			var annotation = self.editorAnnotations.find(function (ann) {
				return ann.id === annotationId;
			});

			if (annotation) {
				Object.assign(annotation, updates);

				// 更新PDF.js的annotationStorage
				if (self.thePDF && self.thePDF.annotationStorage) {
					var pdfAnnotation = self.thePDF.annotationStorage.getRawValue(annotationId);
					if (pdfAnnotation) {
						// 更新PDF注释数据
						Object.assign(pdfAnnotation, updates);
						self.thePDF.annotationStorage.setValue(annotationId, pdfAnnotation);
					}
				}

				// 重新渲染注释
				self.renderAnnotation(annotation);
			}
		},

		// 删除注释
		removeAnnotation: function (annotationId) {
			var self = this;

			// 从PDF.js的annotationStorage中删除
			if (self.thePDF && self.thePDF.annotationStorage) {
				self.thePDF.annotationStorage.remove(annotationId);
			}

			// 从前端注释数组中删除
			self.editorAnnotations = self.editorAnnotations.filter(function (ann) {
				return ann.id !== annotationId;
			});

			// 从DOM中移除
			var element = document.querySelector('[data-annotation-id="' + annotationId + '"]');
			if (element) {
				element.remove();
			}
		},

		// 获取所有注释
		getAllAnnotations: function () {
			var self = this;
			return self.editorAnnotations || [];
		},

		// 获取PDF注释存储状态
		getAnnotationStorageStatus: function () {
			var self = this;
			if (self.thePDF && self.thePDF.annotationStorage) {
				return {
					size: self.thePDF.annotationStorage.size,
					hasAnnotations: self.thePDF.annotationStorage.size > 0
				};
			}
			return {
				size: 0,
				hasAnnotations: false
			};
		},

		// 事件系统

		// 编辑器功能API
		setEditorMode: function (mode) {
			var self = this;

			// 验证模式
			var validModes = ['NONE', 'FREETEXT', 'INK', 'STAMP'];
			if (!validModes.includes(mode)) {
				return false;
			}

			// 更新模式
			self.annotationEditorMode = mode;
			self.isEditing = (mode !== 'NONE');

			// 触发事件
			self.trigger('editorModeChanged', { mode: mode });

			// 更新UI状态
			self.updateEditorUI();

			return true;
		},

		getEditorMode: function () {
			return this.annotationEditorMode;
		},

		setEditorParam: function (param, value) {
			var self = this;

			// 初始化编辑器参数对象
			if (!self.editorParams) {
				self.editorParams = {};
			}

			// 设置参数
			self.editorParams[param] = value;
			self.trigger('editorParamChanged', { param: param, value: value });
			return true;
		},

		getEditorParam: function (param) {
			return this.editorParams[param] || null;
		},

		updateEditorUI: function () {
			var self = this;

			// 更新所有页面容器的编辑器状态
			for (var i = 1; i <= self.totalNum; i++) {
				var container = self.cache[i + ""].container;
				if (container) {
					// 移除之前的编辑器类
					container.classList.remove('editor-freetext', 'editor-ink', 'editor-stamp');

					// 添加新的编辑器类
					if (self.isEditing) {
						container.classList.add('editor-' + self.annotationEditorMode.toLowerCase());
					}

					// 更新鼠标样式
					if (self.isEditing) {
						container.style.cursor = self.getEditorCursor();
					} else {
						container.style.cursor = 'default';
					}
				}
			}
		},

		getEditorCursor: function () {
			switch (this.annotationEditorMode) {
				case 'FREETEXT':
					return 'text';
				case 'INK':
					return 'crosshair';
				case 'STAMP':
					return 'copy';
				default:
					return 'default';
			}
		},

		// 添加注释
		addAnnotation: function (annotation) {
			var self = this;

			// 生成唯一ID
			annotation.id = 'annotation_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
			annotation.timestamp = new Date().toISOString();

			// 添加到注释数组
			self.editorAnnotations.push(annotation);

			// 触发事件
			self.trigger('annotationAdded', { annotation: annotation });

			return annotation.id;
		},


		// 获取所有注释
		getAnnotations: function () {
			return this.editorAnnotations;
		},

		// 清除所有注释
		clearAnnotations: function () {
			this.editorAnnotations = [];
			this.trigger('annotationsCleared');
		},

		// 初始化编辑器事件监听
		initEditorEvents: function () {
			var self = this;

			// 监听页面点击事件
			self.viewerContainer.addEventListener('click', function (e) {
				if (!self.isEditing) return;

				// 阻止事件冒泡，避免触发其他点击事件
				e.stopPropagation();

				var target = e.target;
				var pageContainer = target.closest('.pageContainer');

				if (pageContainer) {
					var pageNum = parseInt(pageContainer.getAttribute('name').split('=')[1]);
					self.handleEditorClick(e, pageNum);
				}
			});

			// 墨迹功能已移除

			// 监听鼠标按下事件
			self.viewerContainer.addEventListener('mousedown', function (e) {
				if (!self.isEditing) return;

				var target = e.target;
				var pageContainer = target.closest('.pageContainer');

				if (pageContainer) {
					self.handleEditorMouseDown(e, pageContainer);
				}
			});

			// 监听鼠标释放事件
			self.viewerContainer.addEventListener('mouseup', function (e) {
				if (!self.isEditing) return;

				var target = e.target;
				var pageContainer = target.closest('.pageContainer');

				if (pageContainer) {
					self.handleEditorMouseUp(e, pageContainer);
				}
			});
		},

		// 处理编辑器点击
		handleEditorClick: function (e, pageNum) {
			var self = this;

			// 检查是否在编辑模式
			if (!self.isEditing || self.annotationEditorMode === 'NONE') {
				return;
			}

			// 检查是否点击了现有注释
			var existingAnnotation = self.findAnnotationAtPosition(e, pageNum);
			if (existingAnnotation) {
				self.selectAnnotation(existingAnnotation);
				return;
			}

			// 注释功能已移除
		},



		// 渲染注释到页面
		renderAnnotation: function (annotation) {
			var self = this;

			// 获取页面容器
			var pageContainer = self.cache[annotation.pageNum + ""].container;
			if (!pageContainer) {
				return;
			}

			// 创建图章显示元素
			var stampElement = document.createElement('div');
			stampElement.className = 'stamp-annotation-display';
			stampElement.style.position = 'absolute';
			stampElement.style.left = annotation.x + 'px';
			stampElement.style.top = annotation.y + 'px';
			stampElement.style.width = annotation.width + 'px';
			stampElement.style.height = annotation.height + 'px';
			stampElement.style.border = '2px solid #007bff';
			stampElement.style.cursor = 'move';
			stampElement.style.zIndex = '1000';
			stampElement.setAttribute('data-annotation-id', annotation.id);

			// 创建图片元素
			var imgElement = document.createElement('img');
			imgElement.src = annotation.image;
			imgElement.style.width = '100%';
			imgElement.style.height = '100%';
			imgElement.style.objectFit = 'contain';
			imgElement.draggable = false;

			stampElement.appendChild(imgElement);
			pageContainer.appendChild(stampElement);

			// 添加点击事件监听器
			stampElement.addEventListener('click', function (e) {
				e.stopPropagation();
				self.selectAnnotation(annotation);
			});

		},

		// 选择注释
		selectAnnotation: function (annotation) {
			var self = this;

			// 移除之前选中的注释
			var existingSelected = document.querySelector('.stamp-annotation-display.selected');
			if (existingSelected) {
				existingSelected.classList.remove('selected');
			}

			// 选中当前注释
			var stampElement = document.querySelector('[data-annotation-id="' + annotation.id + '"]');
			if (stampElement) {
				stampElement.classList.add('selected');
				stampElement.style.border = '2px solid #ff0000';

				// 创建控制点
				self.createResizeHandles(stampElement, annotation);
			}
		},

		// 创建调整大小的控制点
		createResizeHandles: function (element, annotation) {
			var self = this;

			// 移除之前的控制点
			var existingHandles = element.querySelectorAll('.resize-handle');
			existingHandles.forEach(function (handle) {
				handle.remove();
			});

			// 创建控制点
			var handles = ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'];
			handles.forEach(function (handle) {
				var handleElement = document.createElement('div');
				handleElement.className = 'resize-handle resize-handle-' + handle;
				handleElement.style.position = 'absolute';
				handleElement.style.width = '8px';
				handleElement.style.height = '8px';
				handleElement.style.backgroundColor = '#007bff';
				handleElement.style.border = '1px solid #fff';
				handleElement.style.cursor = self.getResizeCursor(handle);
				handleElement.style.zIndex = '1001';

				// 设置位置
				var position = self.getHandlePosition(handle, element.offsetWidth, element.offsetHeight);
				handleElement.style.left = position.x + 'px';
				handleElement.style.top = position.y + 'px';

				element.appendChild(handleElement);
			});
		},

		// 获取调整大小的光标
		getResizeCursor: function (handle) {
			var cursors = {
				'nw': 'nw-resize',
				'ne': 'ne-resize',
				'sw': 'sw-resize',
				'se': 'se-resize',
				'n': 'n-resize',
				's': 's-resize',
				'e': 'e-resize',
				'w': 'w-resize'
			};
			return cursors[handle] || 'default';
		},

		// 获取控制点位置
		getHandlePosition: function (handle, width, height) {
			var positions = {
				'nw': { x: -4, y: -4 },
				'ne': { x: width - 4, y: -4 },
				'sw': { x: -4, y: height - 4 },
				'se': { x: width - 4, y: height - 4 },
				'n': { x: width / 2 - 4, y: -4 },
				's': { x: width / 2 - 4, y: height - 4 },
				'e': { x: width - 4, y: height / 2 - 4 },
				'w': { x: -4, y: height / 2 - 4 }
			};
			return positions[handle] || { x: 0, y: 0 };
		},


		// 处理编辑器鼠标按下
		handleEditorMouseDown: function (e, pageContainer) {
			var self = this;
			// 墨迹功能已移除
		},

		// 处理编辑器鼠标释放
		handleEditorMouseUp: async function (e, pageContainer) {
			var self = this;
			// 墨迹功能已移除
		},

		// 查找指定位置的注释
		findAnnotationAtPosition: function (e, pageNum) {
			var self = this;
			var rect = e.target.getBoundingClientRect();
			var x = e.clientX - rect.left;
			var y = e.clientY - rect.top;

			// 查找该页面的所有注释
			for (var i = 0; i < self.editorAnnotations.length; i++) {
				var annotation = self.editorAnnotations[i];
				if (annotation.pageNum === pageNum) {
					// 检查点击位置是否在注释范围内
					if (self.isPointInAnnotation(x, y, annotation)) {
						return annotation;
					}
				}
			}
			return null;
		},

		// 检查点是否在注释范围内
		isPointInAnnotation: function (x, y, annotation) {
			switch (annotation.type) {
				case 'FREETEXT':
					// 文本注释：检查是否在文本区域内
					return x >= annotation.x && x <= annotation.x + annotation.width &&
						y >= annotation.y && y <= annotation.y + annotation.height;
				case 'STAMP':
					// 图章注释：检查是否在图片区域内
					return x >= annotation.x && x <= annotation.x + annotation.width &&
						y >= annotation.y && y <= annotation.y + annotation.height;
				case 'INK':
					// 墨迹注释：检查是否在路径区域内
					return this.isPointInInkPath(x, y, annotation);
				default:
					return false;
			}
		},

		// 检查点是否在墨迹路径内
		isPointInInkPath: function (x, y, annotation) {
			// 简化的墨迹路径检测
			// 实际实现中可以使用更复杂的路径算法
			if (!annotation.path || annotation.path.length === 0) return false;

			var tolerance = 10; // 容差范围
			for (var i = 0; i < annotation.path.length; i++) {
				var point = annotation.path[i];
				var distance = Math.sqrt(Math.pow(x - point.x, 2) + Math.pow(y - point.y, 2));
				if (distance <= tolerance) {
					return true;
				}
			}
			return false;
		},


		// 选择注释
		selectAnnotation: function (annotation) {
			var self = this;

			// 取消之前的选择
			self.deselectAllAnnotations();

			// 设置当前选择的注释
			self.selectedAnnotation = annotation;

			// 触发选择事件
			self.trigger('annotationSelected', { annotation: annotation });

			return annotation;
		},

		// 取消选择所有注释
		deselectAllAnnotations: function () {
			var self = this;

			if (self.selectedAnnotation) {
				var prevAnnotation = self.selectedAnnotation;
				self.selectedAnnotation = null;

				// 触发取消选择事件
				self.trigger('annotationDeselected', { annotation: prevAnnotation });
			}
		},

		// 获取当前选择的注释
		getSelectedAnnotation: function () {
			return this.selectedAnnotation;
		},


		// 移动注释
		moveAnnotation: function (annotationId, newX, newY) {
			var self = this;

			var index = self.editorAnnotations.findIndex(function (ann) {
				return ann.id === annotationId;
			});

			if (index !== -1) {
				var annotation = self.editorAnnotations[index];
				var oldX = annotation.x;
				var oldY = annotation.y;

				// 更新位置
				annotation.x = newX;
				annotation.y = newY;

				// 触发移动事件
				self.trigger('annotationMoved', {
					annotation: annotation,
					oldPosition: { x: oldX, y: oldY },
					newPosition: { x: newX, y: newY }
				});

				return true;
			}

			return false;
		},

		// 调整注释大小
		resizeAnnotation: function (annotationId, newWidth, newHeight) {
			var self = this;

			var index = self.editorAnnotations.findIndex(function (ann) {
				return ann.id === annotationId;
			});

			if (index !== -1) {
				var annotation = self.editorAnnotations[index];
				var oldWidth = annotation.width;
				var oldHeight = annotation.height;

				// 更新尺寸
				annotation.width = newWidth;
				annotation.height = newHeight;

				// 触发调整大小事件
				self.trigger('annotationResized', {
					annotation: annotation,
					oldSize: { width: oldWidth, height: oldHeight },
					newSize: { width: newWidth, height: newHeight }
				});

				return true;
			}

			return false;
		},

		// 获取指定页面的所有注释
		getAnnotationsByPage: function (pageNum) {
			return this.editorAnnotations.filter(function (annotation) {
				return annotation.pageNum === pageNum;
			});
		},

		// 获取指定类型的注释
		getAnnotationsByType: function (type) {
			return this.editorAnnotations.filter(function (annotation) {
				return annotation.type === type;
			});
		},

		// 导出注释数据
		exportAnnotations: function () {
			return {
				annotations: this.editorAnnotations.slice(),
				exportTime: new Date().toISOString(),
				version: this.version
			};
		},

		// 导入注释数据
		importAnnotations: function (data) {
			var self = this;

			if (data && data.annotations && Array.isArray(data.annotations)) {
				// 清除现有注释
				self.clearAnnotations();

				// 导入新注释
				self.editorAnnotations = data.annotations.slice();

				// 触发导入事件
				self.trigger('annotationsImported', {
					count: self.editorAnnotations.length,
					importTime: data.exportTime
				});

				return true;
			}

			return false;
		},

		// 初始化沙箱管理器
		initSandbox: function () {
			var self = this;

			if (!self.sandboxEnabled || !self.pdfjsLib || !self.pdfjsLib.SandboxManager) {
				return;
			}

			try {
				// 创建沙箱管理器实例
				self.sandboxManager = new self.pdfjsLib.SandboxManager({
					// 沙箱配置
					allowScripts: false,        // 禁止JavaScript执行
					allowForms: true,          // 允许表单交互
					allowPopups: false,        // 禁止弹窗
					allowSameOrigin: true,     // 允许同源访问

					// 安全策略
					sandbox: 'allow-same-origin allow-scripts',
					referrerPolicy: 'strict-origin-when-cross-origin',

					// 容器配置
					container: self.viewer,

					// 事件处理
					onError: function (error) {
						console.warn('Sandbox error:', error);
					},

					onSecurityViolation: function (violation) {
						console.warn('Security violation blocked:', violation);
					}
				});

				console.info('PDF.js sandbox initialized successfully');
			} catch (error) {
				console.warn('Failed to initialize sandbox:', error);
				self.sandboxEnabled = false;
			}
		},

		// 启用/禁用沙箱
		setSandboxEnabled: function (enabled) {
			this.sandboxEnabled = enabled;

			if (enabled && !this.sandboxManager) {
				this.initSandbox();
			} else if (!enabled && this.sandboxManager) {
				this.destroySandbox();
			}
		},

		// 销毁沙箱
		destroySandbox: function () {
			if (this.sandboxManager) {
				try {
					this.sandboxManager.destroy();
					this.sandboxManager = null;
				} catch (error) {
					console.warn('Error destroying sandbox:', error);
				}
			}
		},

		// 获取沙箱状态
		getSandboxStatus: function () {
			return {
				enabled: this.sandboxEnabled,
				initialized: !!this.sandboxManager,
				active: this.sandboxManager ? this.sandboxManager.isActive() : false
			};
		},

		// 处理密码错误
		handlePasswordError: function (error) {
			var self = this;

			// 如果正在验证密码，显示错误信息
			if (self.passwordValidating) {
				self.showPasswordError('密码错误，请重新输入');
				self.passwordValidating = false; // 重置标志
			} else if (self.passwordPrompt && self.passwordPrompt.parentNode) {
				// 如果密码框已经存在，显示错误信息
				self.showPasswordError('密码错误，请重新输入');
			} else {
				// 如果没有密码框，显示密码输入框
				self.showPasswordPrompt();
			}
		},

		// 显示密码输入框
		showPasswordPrompt: function () {
			var self = this;

			// 如果已有密码框，先移除
			if (self.passwordPrompt) {
				self.hidePasswordPrompt();
			}

			// 使用原生DOM创建方式，避免innerHTML解析问题
			self.passwordPrompt = document.createElement('div');
			self.passwordPrompt.className = 'pdfh5-password-prompt';
			self.passwordPrompt.style.cssText = `
				position: fixed;
				top: 0;
				left: 0;
				width: 100%;
				height: 100%;
				background: rgba(0,0,0,0.7);
				z-index: 9999;
				display: flex;
				align-items: center;
				justify-content: center;
				padding: 16px;
				box-sizing: border-box;
			`;

			// 创建内容容器
			var contentDiv = document.createElement('div');
			contentDiv.style.cssText = `
				background: white;
				padding: 24px;
				border-radius: 12px;
				box-shadow: 0 8px 32px rgba(0,0,0,0.12);
				width: 100%;
				max-width: 400px;
				text-align: center;
				box-sizing: border-box;
			`;

			// 移动端适配
			if (window.innerWidth <= 768) {
				contentDiv.style.cssText += `
					padding: 20px;
					margin: 0 8px;
					border-radius: 8px;
				`;
			}

			// 创建标题
			var title = document.createElement('div');
			title.textContent = '提示';
			title.style.cssText = 'margin: 0 0 16px 0; color: #333; font-size: 18px; font-weight: 600;';
			contentDiv.appendChild(title);

			// 创建错误提示信息（初始隐藏）
			var errorMessage = document.createElement('div');
			errorMessage.id = 'pdfh5-password-error';
			errorMessage.textContent = '密码错误，请重新输入';
			errorMessage.style.cssText = `
				margin: 0 0 16px 0;
				color: #dc3545;
				font-size: 14px;
				display: none;
				text-align: center;
			`;
			contentDiv.appendChild(errorMessage);

			// 创建密码输入框
			var passwordInput = document.createElement('input');
			passwordInput.type = 'password';
			passwordInput.id = 'pdfh5-password-input';
			passwordInput.placeholder = '请输入PDF文件的密码';
			passwordInput.style.cssText = `
				width: 100%;
				padding: 12px 16px;
				border: 2px solid #e1e5e9;
				border-radius: 8px;
				margin-bottom: 24px;
				font-size: 16px;
				box-sizing: border-box;
				outline: none;
				transition: border-color 0.3s ease;
			`;

			// 移动端输入框适配
			if (window.innerWidth <= 768) {
				passwordInput.style.cssText += `
					padding: 14px 16px;
					font-size: 16px;
					margin-bottom: 20px;
				`;
			}

			contentDiv.appendChild(passwordInput);

			// 创建按钮容器
			var buttonContainer = document.createElement('div');
			buttonContainer.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end;';

			// 移动端按钮布局适配
			if (window.innerWidth <= 768) {
				buttonContainer.style.cssText = 'display: flex; gap: 8px; justify-content: center; flex-direction: column;';
			}

			// 创建确定按钮
			var submitBtn = document.createElement('button');
			submitBtn.id = 'pdfh5-password-submit';
			submitBtn.textContent = '确定';
			submitBtn.style.cssText = `
				background: #007bff;
				color: white;
				border: none;
				padding: 12px 24px;
				border-radius: 8px;
				cursor: pointer;
				font-size: 14px;
				font-weight: 500;
				transition: all 0.2s ease;
				min-width: 80px;
			`;

			// 移动端按钮适配
			if (window.innerWidth <= 768) {
				submitBtn.style.cssText += `
					padding: 14px 24px;
					font-size: 16px;
					width: 100%;
					min-width: auto;
				`;
			}

			buttonContainer.appendChild(submitBtn);

			contentDiv.appendChild(buttonContainer);


			self.passwordPrompt.appendChild(contentDiv);
			document.body.appendChild(self.passwordPrompt);

			// 确保DOM元素已添加到页面
			if (!self.passwordPrompt.parentNode) {
				console.error('Failed to add password prompt to DOM');
				return;
			}

			// 绑定事件 - 使用setTimeout确保DOM完全渲染
			setTimeout(function () {
				// 重新获取元素引用，确保它们存在
				var passwordInputEl = document.getElementById('pdfh5-password-input');
				var submitBtnEl = document.getElementById('pdfh5-password-submit');

				if (!passwordInputEl || !submitBtnEl) {
					console.error('Password prompt elements not found after creation');
					return;
				}

				// 自动聚焦
				passwordInputEl.focus();

				// 输入框焦点效果
				passwordInputEl.addEventListener('focus', function () {
					this.style.borderColor = '#007bff';
				});
				passwordInputEl.addEventListener('blur', function () {
					this.style.borderColor = '#e1e5e9';
				});

				// 按钮悬停效果
				submitBtnEl.addEventListener('mouseenter', function () {
					this.style.background = '#0056b3';
					this.style.transform = 'translateY(-1px)';
				});
				submitBtnEl.addEventListener('mouseleave', function () {
					this.style.background = '#007bff';
					this.style.transform = 'translateY(0)';
				});


				// 回车提交
				passwordInputEl.addEventListener('keypress', function (e) {
					if (e.key === 'Enter') {
						self.submitPassword();
					}
				});

				// 提交按钮
				submitBtnEl.addEventListener('click', function () {
					self.submitPassword();
				});

				// 监听窗口大小变化，重新适配弹窗
				var resizeHandler = function () {
					if (self.passwordPrompt && self.passwordPrompt.parentNode) {
						// 重新应用移动端样式
						var isMobile = window.innerWidth <= 768;
						var contentDiv = self.passwordPrompt.querySelector('div');
						var title = contentDiv.querySelector('h3');
						var passwordInput = document.getElementById('pdfh5-password-input');
						var buttonContainer = contentDiv.querySelector('div:last-child');
						var submitBtn = document.getElementById('pdfh5-password-submit');

						if (contentDiv) {
							if (isMobile) {
								contentDiv.style.cssText = `
									background: white;
									padding: 20px;
									border-radius: 8px;
									box-shadow: 0 8px 32px rgba(0,0,0,0.12);
									width: 100%;
									max-width: 400px;
									text-align: center;
									box-sizing: border-box;
									margin: 0 8px;
								`;
							} else {
								contentDiv.style.cssText = `
									background: white;
									padding: 24px;
									border-radius: 12px;
									box-shadow: 0 8px 32px rgba(0,0,0,0.12);
									width: 100%;
									max-width: 400px;
									text-align: center;
									box-sizing: border-box;
								`;
							}
						}

						if (title) {
							if (isMobile) {
								title.style.cssText = 'margin: 0 0 12px 0; color: #333; font-size: 16px; font-weight: 600;';
							} else {
								title.style.cssText = 'margin: 0 0 16px 0; color: #333; font-size: 18px; font-weight: 600;';
							}
						}

						if (passwordInput) {
							if (isMobile) {
								passwordInput.style.cssText = `
									width: 100%;
									padding: 14px 16px;
									border: 2px solid #e1e5e9;
									border-radius: 8px;
									margin-bottom: 20px;
									font-size: 16px;
									box-sizing: border-box;
									outline: none;
									transition: border-color 0.3s ease;
								`;
							} else {
								passwordInput.style.cssText = `
									width: 100%;
									padding: 12px 16px;
									border: 2px solid #e1e5e9;
									border-radius: 8px;
									margin-bottom: 24px;
									font-size: 16px;
									box-sizing: border-box;
									outline: none;
									transition: border-color 0.3s ease;
								`;
							}
						}

						if (buttonContainer) {
							if (isMobile) {
								buttonContainer.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end; flex-direction: column;';
							} else {
								buttonContainer.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end;';
							}
						}

						if (submitBtn) {
							if (isMobile) {
								submitBtn.style.cssText = `
									background: #007bff;
									color: white;
									border: none;
									padding: 14px 24px;
									border-radius: 8px;
									cursor: pointer;
									font-size: 16px;
									font-weight: 500;
									transition: all 0.2s ease;
									width: 100%;
								`;
							} else {
								submitBtn.style.cssText = `
									background: #007bff;
									color: white;
									border: none;
									padding: 12px 24px;
									border-radius: 8px;
									cursor: pointer;
									font-size: 14px;
									font-weight: 500;
									transition: all 0.2s ease;
									min-width: 80px;
								`;
							}
						}
					}
				};

				// 添加窗口大小变化监听
				window.addEventListener('resize', resizeHandler);

				// 在密码框关闭时移除监听器
				var originalHidePasswordPrompt = self.hidePasswordPrompt;
				self.hidePasswordPrompt = function () {
					window.removeEventListener('resize', resizeHandler);
					originalHidePasswordPrompt.call(self);
				};
			}, 100);
		},

		// 提交密码
		submitPassword: function () {
			var self = this;
			var passwordInput = document.getElementById('pdfh5-password-input');

			if (!passwordInput) {
				console.error('Password input not found');
				return;
			}

			var password = passwordInput.value.trim();

			if (!password) {
				self.showPasswordError('请输入密码');
				return;
			}

			// 隐藏错误信息
			self.hidePasswordError();

			// 设置一个标志，表示正在验证密码
			self.passwordValidating = true;

			// 重新加载PDF，使用新密码
			self.loadPDFWithPassword(password);
		},

		// 显示密码错误信息
		showPasswordError: function (message) {
			var self = this;
			var errorElement = document.getElementById('pdfh5-password-error');
			if (errorElement) {
				errorElement.textContent = message || '密码错误，请重新输入';
				errorElement.style.display = 'block';

				// 清空密码输入框
				var passwordInput = document.getElementById('pdfh5-password-input');
				if (passwordInput) {
					passwordInput.value = '';
					passwordInput.focus();
				}
			}
		},

		// 隐藏密码错误信息
		hidePasswordError: function () {
			var self = this;
			var errorElement = document.getElementById('pdfh5-password-error');
			if (errorElement) {
				errorElement.style.display = 'none';
			}
		},


		// 隐藏密码输入框
		hidePasswordPrompt: function () {
			var self = this;
			if (self.passwordPrompt && self.passwordPrompt.parentNode) {
				self.passwordPrompt.parentNode.removeChild(self.passwordPrompt);
				self.passwordPrompt = null;
			}
		},

		// 使用密码重新加载PDF
		loadPDFWithPassword: function (password) {
			var self = this;

			// 更新选项中的密码
			self.options.password = password;

			// 重新加载PDF
			self.loadPDF();
		},


		// 获取密码配置状态
		getPasswordConfig: function () {
			return {
				hasPassword: !!this.options.password
			};
		},

		destroy: function (callback) {
			// 销毁沙箱
			this.destroySandbox();

			// 清理密码相关资源
			this.hidePasswordPrompt();

			// 销毁PinchZoom
			if (this.pinchZoom) {
				this.pinchZoom.destroy();
				this.pinchZoom = null;
			}

			// 清理窗口大小变化监听器
			if (this.resizeHandler) {
				window.removeEventListener('resize', this.resizeHandler);
				this.resizeHandler = null;
			}

			if (this.thePDF && this.thePDF.destroy) {
				this.thePDF.destroy();
				this.thePDF = null;
			}
			if (this.viewerContainer) {
				this.viewerContainer.parentNode.removeChild(this.viewerContainer);
				this.viewerContainer = null;
			}
			if (this.container) {
				this.container.innerHTML = "";
			}
			callback && callback.call(this);
		}
	};

	return Pdfh5;
});
