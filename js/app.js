define(function (require) {
	'use strict';

	var $          = require('jquery');
	var _          = require('lodash');
	var d3         = require('d3');
	var tinycolor  = require('tinycolor');
	var jsHue      = require('jshue');
	var colors     = require('hue-hacking');
	var ColorWheel = require('colorwheel');
	var observejs  = require('observe-js');

	// Collection of strings the app may need to show the user
	var msg = {
		CONNECTING              : 'Connecting...',
		SUCCESS                 : 'Successfully connected to local bridge!',
		NO_BRIDGE               : 'No Philips Hue bridge found on your local network.',
		PRESS_BUTTON            : 'Please authenticate by pressing the button on the Hue bridge.',
		CONNECTION_ERROR_GENERIC: 'Unable to connect to the Internet.',
		CONNECTION_ERROR_BRIDGE : 'Unable to connect to local bridge.',
		UNAUTHORIZED_USER       : 'Unauthorized user.'
	};

	var app = {
		APP_ID: 'huepie', // for registering with the API
		APP_USERNAME: 'huepie-user',
		hue: jsHue(), // jsHue instance
		api: null, // jsHueUser instance
		wheel: null, // ColorWheel instance
		bridgeIP: null, // the bridge IP
		username: null, // the hue API username
		cache: {}, // for caching API data
		lights: {},
		template: document.querySelector('#app'), // template used for data binding
		initSettings: '', // serialized copy of settings on init

		colorWheelOptions: { // options for the ColorWheel instance
			container: '#wheel',
			markerWidth: 45
		},

		$: { // jQuery references to DOM nodes
			status:   $('#status'),
			controls: $('#controls')
		},

		// Cache the full Hue Bridge state
		cacheFullState: function () {
			console.log('Caching API fullState...');
			var self = this;
			return new Promise(function (resolve, reject) {
				self.api.getFullState(function (data) {
					if (data.length && data[0].error) {
						if (data[0].error.type == 1) {
							self.createAPIUser().then(self.cacheFullState.bind(self), reject).then(resolve, reject);
						} else {
							reject(Error('"' + data[0].error.description + '" (error type ' + data[0].error.type + ')'));
						}
					} else {
						self.cache.fullState = data;
						if (! self.template.settings.lights) {
							self.lights = data.lights;
						} else {
							self.lights = {};
							for (var lid in data.lights) {
								var light = data.lights[lid];
								var setting = _.find(self.template.settings.lights, { name: light.name });
								if (! setting || setting.active) {
									self.lights[lid] = light;
								}
							}
						}
						self.observeChanges();
						self.$.status.attr({ duration: 3000, text: msg.SUCCESS }).get(0).show();
						resolve();
					}
				},
				function (error) {
					window.localStorage.removeItem('bridge_ip');
					reject(Error(msg.CONNECTION_ERROR_BRIDGE));
				});
			});
		},

		observeChanges: function () {
			var self = this;
			if (! Object.observe) {
				window.setInterval(Platform.performMicrotaskCheckpoint, 100);
			}
			$.each(self.lights, function (lid, light) {
				// See: https://github.com/polymer/observe-js
				var observer = new ObjectObserver(light.state);
				observer.open(function (added, removed, changed, getOldValueFn) {
					if (Object.keys(changed).length > 0) {
						self.api.setLightState(lid, changed);
					}
				});
				// --- This is how we would do it with native O.o: ---
				// Object.observe(light.state, function (changes) {
				// 	changes.forEach(function (change) {
				// 		if (change.type == 'update') {
				// 			if (JSON.stringify(light.state[change.name]) !== JSON.stringify(change.oldValue)) {
				// 				var update = {};
				// 				update[change.name] = light.state[change.name];
				// 				self.api.setLightState(lid, update);
				// 			}
				// 		}
				// 	});
				// });
			});
		},

		// This is some complicated unelegant shit. An LID-to-marker map is created
		// based on the DOM order & visibility of theme swatches, mashed with the LIDs
		// based on their appearance in the "on" switches table or "off" table.
		getLIDToMarkerMap: function () {
			var lidToMarkerMap = [];
			var lids = this.$.controls.find('.Switch').map(function () { return $(this).data('lid') });
			var visibleSwatches = $('.Theme-swatch:visible').toArray();
			var hiddenSwatches = $('.Theme-swatch:hidden').toArray();
			$(visibleSwatches.concat(hiddenSwatches)).each(function (index) {
				lidToMarkerMap[lids[index]] = window.parseInt($(this).attr('data-marker-id'));
			});
			return lidToMarkerMap;
		},

		// See if there is already a saved username, if not create one
		getAPIUser: function () {
			console.log('Getting API user...');
			this.api = this.hue.bridge(this.bridgeIP).user(this.APP_USERNAME);
		},

		// Creates a new API user, only succeeds if the Bridge's button has been pressed
		createAPIUser: function () {
			console.log('Creating a new API user...');
			var self = this;
			return new Promise(function (resolve, reject) {
				self.api.create(
					self.APP_ID,
					function (data) {
						if (data[0].success) {
							resolve();
						} else {
							if (data[0].error.type === 101) {
								reject(Error(msg.PRESS_BUTTON));
							} else {
								reject(Error(data[0].error.description));
							}
						}
					},
					function () { // ajax error
						reject(Error(msg.CONNECTION_ERROR_BRIDGE));
					}
				);
			});
		},

		// Hunt for the local Hue Bridge
		connectToLocalBridge: function () {
			console.log('Connecting to local bridge...');
			var self = this;
			return new Promise(function (resolve, reject) {
				var bridgeIP;
				if (bridgeIP = window.localStorage.getItem('bridge_ip')) {
					self.bridgeIP = bridgeIP;
					resolve();
					return;
				}
				self.hue.discover(
					function (bridges) {
						if (bridges.length === 0) {
							reject(Error(msg.NO_BRIDGE));
						} else {
							self.bridgeIP = bridges[0].internalipaddress;
							window.localStorage.setItem('bridge_ip', self.bridgeIP);
							resolve();
						}
					},
					function (error) {
						reject(Error(msg.CONNECTION_ERROR_GENERIC));
					}
				);
			});
		},

		// Updates light states after wheel user interaction
		wheelUpdateAction: function () {
			for (var lid in this.lights) {
				var light = this.lights[lid];
				if (light.state.on) {
					var markerIndex = this.getLIDToMarkerMap()[lid];
					var d = d3.select(this.wheel.getMarkers()[0][markerIndex]).datum();
					var hex = tinycolor({h: d.color.h, s: d.color.s, v: d.color.v}).toHexString();
					light.state.xy = colors.hexToCIE1931(hex);
				}
			}
		},

		modeToggleAction: function () {
			if (this.wheel.currentMode == ColorWheel.modes.MONOCHROMATIC) {
				this.wheel.getMarkers().data().forEach(function (d) {
					d.color.s = 1;
					d.color.v = 1;
				});
				this.wheel.dispatch.markersUpdated();
				this.wheel.dispatch.updateEnd();
			}
		},

		// Renders the ColorWheel when everything's ready
		renderWheel: function () {
			var wheelData = [];
			for (var lid in this.lights) {
				var light = this.lights[lid];
				var lightHex = colors.CIE1931ToHex.apply(null, light.state.xy);
				var lightHue = tinycolor(lightHex).toHsv().h;
				wheelData.push(ColorWheel.createMarker(
					{ h: lightHue, s: 1, v: 100 },
					null,
					light.state.on
				));
			}
			this.wheel = new ColorWheel(this.colorWheelOptions);
			this.wheel.bindData(wheelData);
			this.wheel.dispatch.on('modeChanged.huepie', this.modeToggleAction.bind(this));
			this.wheel.dispatch.on('updateEnd.huepie', this.wheelUpdateAction.bind(this));
		},

		// Renders the light switches and attached behavior
		renderControls: function () {
			var self = this;
			var rows = { on: [], off: [] };
			var controls = {
				on: $('<div>').addClass('Switches Switches--on'),
				off: $('<div>').addClass('Switches Switches--off')
			};

			$.each(this.lights, function (lid, light) {
				var $row = $('<div class="Switch">').attr('data-lid', lid);
				var slider = document.createElement('paper-slider');
				var toggle = document.createElement('paper-toggle-button');

				// Add on/off switch
				Polymer.dom(toggle).setAttribute('class', 'Switch-toggle');
				toggle.checked = !! light.state.on;
				toggle.addEventListener('change', function () {
					var markerIndex = self.getLIDToMarkerMap()[lid];
					var marker = d3.select(self.wheel.getMarkers()[0][markerIndex]);
					marker.datum().show = this.checked;
					slider.disabled = ! this.checked;
					light.state.on = this.checked;
					self.wheel.dispatch.markersUpdated();
					self.wheel.setHarmony();
					self.wheel.dispatch.updateEnd();
					$(this).closest('div')
						[light.state.on ? 'appendTo' : 'prependTo']
						(controls[light.state.on ? 'on': 'off']);
				});

				// Add brightness slider
				Polymer.dom(slider).setAttribute('class', 'Switch-slider');
				slider.pin = true;
				slider.min = 0;
				slider.max = 255;
				slider.value = light.state.bri;
				slider.disabled = ! light.state.on;
				slider.addEventListener('change', function () {
					light.state.bri = this.value;
				});

				$row.append( $('<b>').text(light.name) );
				$row.append(toggle);
				$row.append(slider);
				rows[light.state.on ? 'on' : 'off'].push($row);
			});
			controls.on.append(rows.on).appendTo(this.$.controls);
			controls.off.append(rows.off).appendTo(this.$.controls);
		},

		// Builds the UI once the Hue API has been loaded
		render: function () {
			this.bindTemplate();
			this.renderWheel();
			this.renderControls();
		},

		// Displays an error to the user, expecting an Error instance
		showError: function (e) {
			console.warn(e.stack);
			if (e.message == msg.PRESS_BUTTON) {
				this.$.status.find('a').text('Tap to retry');
				this.$.status.click(this.init.bind(this));
			}
			if (e.message == msg.NO_BRIDGE) {
				this.$.status.find('a').text('Tap to restart in demo mode');
				this.$.status.click(this.demo.bind(this));
			}
			this.$.status.attr({ text: e.message }).get(0).show();
		},

		resetStatus: function () {
			this.$.status.get(0).hide();
			this.$.status.find('a').empty();
		},

		bindTemplate: function () {
			var self = this;
			this.template.selected = 0;
			this.template.bridgeIP = this.bridgeIP;
			this.template.version = '0.3.0';
			// Settings
			this.template.set('settings.rotate', false);
			this.template.set('settings.lights', _.map(this.cache.fullState.lights,
				function (light, lid) {
					var setting = _.find(self.template.settings.lights, { name: light.name });
					return { name: light.name, active: setting ? setting.active : true };
				}
			));
			this.initSettings = JSON.stringify(this.template.settings);
			document.querySelector('paper-dialog')
				.addEventListener('iron-overlay-closed', this.readSettings.bind(this));
		},

		// Any time we suspect settings have changed, read them and take appropriate action.
		readSettings: function () {
			// If light settings have changed, refresh the page.
			if (this.initSettings.indexOf(JSON.stringify(this.template.settings.lights)) === -1) {
				window.location.reload();
			}
			// If light rotate is enabled, set the timer.
			if (this.template.settings.rotate) {
				this.interval = window.setInterval(
					this.randomizeColors.bind(this),
					this.template.settings.interval * 1000
				);
			} else {
				window.clearInterval(this.interval);
			}
		},

		randomizeColors: function () {
			var onLights = _.filter(this.lights, function (light) { return light.state.on });
			var shuffled = _.shuffle(_.map(onLights, function (light) {
				return light.state.xy;
			}));
			_.forEach(onLights, function (light) {
				light.state.xy = shuffled.pop();
			});
		},

		// Start the app!
		init: function () {
			this.resetStatus();
			this.$.status.attr({ text: msg.CONNECTING, duration: 1e10 }).get(0).show();
			this.connectToLocalBridge()
				.then(this.getAPIUser.bind(this))
				.then(this.cacheFullState.bind(this))
				.then(this.render.bind(this))
				.catch(this.showError.bind(this));
		},

		// Start the app in demo mode, using mock data.
		demo: function () {
			var self = this;
			self.resetStatus();
			$.get('demo.json', function (data) {
				self.bridgeIP = 'DEMO';
				self.cache.fullState = data;
				self.render();
			});
		}
	};

	return app;
});
