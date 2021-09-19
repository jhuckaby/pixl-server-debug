// Chrome Dev Tools Debugger Launcher
// A component for the pixl-server daemon framework.
// Copyright (c) 2021 Joseph Huckaby
// Released under the MIT License

// TODO: auto-shutdown 9229 listener after N minutes of inactivity -- can we sniff the connected clients?

const assert = require('assert');
const fs = require('fs');
const cp = require('child_process');
const Path = require('path');
const Class = require('class-plus');
const Component = require('pixl-server/component');
const Tools = require('pixl-tools');

module.exports = Class({
	
	defaultConfig: {
		enabled: false,
		base_uri: '/internal/debug',
		secret_key: '',
		acl: true,
		host: "0.0.0.0",
		port: 9229
	}
	
},
class Debug extends Component {
	
	startup(callback) {
		// start debug service
		this.logDebug(3, "Debug service listening for base URI: " + this.config.get('base_uri') );
		
		// add URI handler
		if (!this.server.WebServer) return callback( new Error("pixl-server-web is required to use pixl-server-debug.") );
		this.web = this.server.WebServer;
		this.pm = this.server.PoolManager || null; // optional
		
		this.web.addURIHandler(
			new RegExp('^' + this.config.get('base_uri')),
			"Debug Service",
			this.config.get('acl'), 
			this.handler.bind(this)
		);
		
		this.baseMatch = new RegExp('^' + this.config.get('base_uri') + '/?$');
		this.styleMatch = new RegExp( '^' + this.config.get('base_uri') + '/style.css$' );
		this.shaMatch = new RegExp( '^' + this.config.get('base_uri') + '/sha256.js$' );
		this.apiMatch = new RegExp('^' + this.config.get('base_uri') + "/api/(\\w+)");
		
		// copy refs to global on inspector start
		this.globals = {
			server: this.server
		};
		
		// dead man's switch
		this.server.on('minute', this.maint.bind(this));
		
		callback();
	}
	
	addGlobals(obj) {
		// add custom globals when debugger starts
		Tools.mergeHashInto( this.globals, obj );
	}
	
	handler(args, callback) {
		// debug web and api service
		var url = args.request.url;
		
		if (!this.config.get('enabled')) {
			callback( "400 Bad Request", {}, "Debug Service is disabled." );
		}
		else if (url.match(this.baseMatch)) {
			args.internalFile = Path.resolve(__dirname + '/index.html');
			callback(false);
		}
		else if (url.match(this.styleMatch)) {
			args.internalFile = Path.resolve(__dirname + '/style.css');
			callback(false);
		}
		else if (url.match(this.shaMatch)) {
			args.internalFile = Path.resolve(__dirname + '/node_modules/js-sha256/build/sha256.min.js');
			callback(false);
		}
		else if (url.match(this.apiMatch)) {
			var func = 'handler_' + RegExp.$1;
			if (!this[func]) return callback( "400 Bad Request", {}, "Invalid Debug API" );
			this[func](args, callback);
		}
		else {
			callback( "400 Bad Request", {}, "Invalid Debug URI" );
		}
	}
	
	handler_config(args, callback) {
		// send back basic config for web app
		callback({
			title: this.server.__name
		});
	}
	
	handler_challenge(args, callback) {
		// start auth challenge
		var time_code = Math.floor( Tools.timeNow() / 60 );
		var secret_key = this.config.get('secret_key') || this.server.config.get('secret_key');
		if (!secret_key) return this.doError(1, "No secret key defined in server configuration.", callback);
		
		var nonce = Tools.digestHex( '' + time_code + secret_key, 'sha256' );
		callback({ code: 0, nonce: nonce });
	}
	
	require_auth(args, callback) {
		// make sure auth is valid
		if (!args.query.nonce) {
			return this.doError(1, "Missing nonce parameter.", callback);
		}
		if (!args.query.auth) {
			return this.doError(1, "Missing auth parameter.", callback);
		}
		
		var secret_key = this.config.get('secret_key') || this.server.config.get('secret_key');
		var correct_auth = Tools.digestHex( '' + args.query.nonce + secret_key, 'sha256' );
		if (args.query.auth != correct_auth) {
			return this.doError(1, "Invalid auth token.", callback);
		}
		
		// make sure nonce isn't stale
		var time_code = Math.floor( Tools.timeNow() / 60 );
		var nonce = Tools.digestHex( '' + time_code + secret_key, 'sha256' );
		if (args.query.nonce != nonce) {
			// allow some slop for minute rollover
			var slop_nonce = Tools.digestHex( '' + Math.floor(time_code - 1) + secret_key, 'sha256' );
			if (args.query.nonce != slop_nonce) {
				this.logDebug(9, "Nonce is stale, sending back new challenge");
				callback({ code: 'refresh', description: "Stale nonce, please refresh token.", nonce });
				return false;
			}
		}
		
		if (!args.request.headers.host || !args.request.headers.host.replace(/\:\d+$/, '').match("^(" + this.server.ip + '|' + this.server.hostname + "|localhost|127.0.0.1)$")) {
			return this.doError(1, "Invalid hostname or IP.", callback);
		}
		
		this.logDebug(9, "Authentication successful");
		return true;
	}
	
	handler_list(args, callback) {
		// get list of available processes for debugging
		// current process, plus maybe workers if pixl-server-pool is active
		var self = this;
		if (!this.require_auth(args, callback)) return;
		
		var procs = [];
		procs.push({ pid: process.pid, title: this.server.__name + " Main Process" });
		
		// retry this in case app has overridden it with a custom implementation
		this.pm = this.server.PoolManager || null; // optional
		
		if (this.pm) {
			// include all pixl-server-pool workers
			var pools = this.pm.getPools();
			
			for (var pool_id in pools) {
				var pool = pools[pool_id];
				var pool_title = pool_id.substring(0, 1).toUpperCase() + pool_id.substring(1, pool_id.length);
				var workers = pool.getWorkers();
				
				for (var pid in workers) {
					procs.push({ pid: pid, pool: pool_id, title: pool_title + " Worker #" + pid });
				} // foreach worker
			} // foreach pool
		} // pm
		
		// shell exec to get running process cpu and memory usage
		// this works on at least: OS X, Fedora, Ubuntu and CentOS
		var finish = function(err, stdout, stderr) {
			if (err) {
				var msg = "Failed to exec ps: " + err;
				self.logError('exec', msg);
				if (callback) { callback({ code: 1, description: msg }); callback = null; }
				return;
			}
			var lines = stdout.split(/\n/);
			var pids = {};
			
			// process each line from ps response
			for (var idx = 0, len = lines.length; idx < len; idx++) {
				var line = lines[idx];
				if (line.match(/(\d+)\s+(\d+)\s+([\d\.]+)\s+(\d+)/)) {
					var ppid = parseInt( RegExp.$1 );
					var pid = parseInt( RegExp.$2 );
					var cpu = parseFloat( RegExp.$3 );
					var mem = parseInt( RegExp.$4 ) * 1024; // k to bytes
					pids[ pid ] = { ppid: ppid, cpu: cpu, mem: mem };
				} // good line
			} // foreach line
			
			// match up to pool pids
			procs.forEach( function(proc) {
				var info = pids[ proc.pid ];
				if (info) {
					Tools.mergeHashInto( proc, info );
					proc.memText = Tools.getTextFromBytes( proc.mem );
					proc.cpuText = Tools.pct( proc.cpu, 100 );
				}
			} );
			
			if (callback) { callback({ code: 0, procs: procs }); callback = null; }
		}; // finish
		
		var cmd = '/bin/ps -eo "ppid pid %cpu rss"';
		var child = null;
		try {
			child = cp.exec( cmd, { timeout: 5 * 1000 }, finish );
		}
		catch(err) {
			var msg = "Failed to exec ps: " + err;
			self.logError('exec', msg);
			if (callback) { callback({ code: 1, description: msg }); callback = null; }
		}
		if (child && child.pid && child.on) child.on('error', function (err) {
			var msg = "Failed to exec ps: " + err;
			self.logError('exec', msg);
			if (callback) { callback({ code: 1, description: msg }); callback = null; }
		});
	}
	
	handler_start(args, callback) {
		// start debugging, after auth check
		if (!this.require_auth(args, callback)) return;
		
		this.origDebugLevel = this.server.logger.get('debugLevel');
		this.debuggerEnabled = true;
		this.lastPing = Tools.timeNow(true);
		
		if (args.query.pool && args.query.pid) {
			// start debugger in worker process
			return this.start_worker(args, callback);
		}
		
		// start debugger in parent process
		if (!this.inspector) {
			this.inspector = this.server.Inspector = require('inspector');
		}
		
		if (!this.inspector.url()) {
			this.logDebug(2, "Opening debug inspector on port " + this.config.get('port'));
			this.inspector.open( this.config.get('port'), this.config.get('host') );
		}
		
		var url = this.inspector.url();
		this.logDebug(5, "Inspector URL: " + url);
		
		url = url.replace(/^(\w+\:\/\/)([\w\-\.]+)(.+)$/, '$1' + this.server.ip + '$3');
		this.logDebug(5, "Swapping in LAN IP: " + url);
		
		url = url.replace(/^\w+\:\/\//, 'devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=');
		this.logDebug(5, "Wrapping in devtools proto: " + url);
		
		callback({ 
			code: 0, 
			url: url,
			pid: process.pid,
			echo: this.server.logger.get('echo'),
			debugLevel: this.origDebugLevel
		});
		
		// infuse globals for easy access from inspector
		Tools.mergeHashInto( global, this.globals );
		
		// log welcome message to inspector log
		this.inspector.console.log("%cNode.js Remote Debugger has started.", "color:green; font-family:sans-serif; font-size:20px");
		this.inspector.console.log("%c" + this.server.__name + " Parent Process (PID " + process.pid + ")", "color:green; font-family:sans-serif;");
		this.inspector.console.log("%cCustom globals available: " + Object.keys(this.globals).sort().join(', '), "color:green; font-family:sans-serif;");
	}
	
	start_worker(args, callback) {
		// send debug start message to worker process
		if (!this.pm) return this.doError(1, "pixl-server-pool not installed.", callback);
		
		var pool = this.pm.getPool( args.query.pool );
		if (!pool) return this.doError(1, "Pool not found: " + args.query.pool, callback);
		
		var worker = pool.getWorker( args.query.pid );
		if (!worker) return this.doError(1, "Worker not found: " + args.query.pid, callback);
		
		this.logDebug(5, "Starting debug on worker process", args.query);
		
		worker.once('internal', function(data) {
			data.code = 0;
			data.pool = args.query.pool;
			callback(data);
		});
		
		worker.sendInternal({
			action: 'start_debug',
			host: this.config.get('host'),
			port: this.config.get('port')
		});
	}
	
	handler_ping(args, callback) {
		// keep things alive
		if (!this.require_auth(args, callback)) return;
		this.lastPing = Tools.timeNow(true);
		callback({ code: 0 });
	}
	
	handler_logs(args, callback) {
		// enable/disable log mirror, change log level
		// args.query: { echo, level, match }
		var self = this;
		if (!this.require_auth(args, callback)) return;
		if (args.query.pool && args.query.pid) return this.logs_worker(args, callback);
		
		this.logDebug(5, "Changing debug log settings", args.query);
		
		try {
			this.server.logger._echoMatch = new RegExp( args.query.match || '.+' );
		}
		catch (err) {
			this.logError('regexp', "Invalid regular expression for log match: " + args.query.match + ": " + err);
			this.server.logger._echoMatch = /.+/;
		}
		
		if (args.query.echo && (parseInt(args.query.echo) != 0)) {
			this.logDebug(5, "Activating log inspector echo mirror");
			this.server.logger.echoer = function(line, cols, args) {
				if (self.inspector && self.inspector.console && line.match(self.server.logger._echoMatch)) {
					self.inspector.console.log( line );
				}
			};
			this.server.logger.set('echo', true);
		}
		else {
			this.server.logger.set('echo', false);
			this.server.logger.echoer = null;
		}
		
		if (args.query.level) {
			this.server.logger.set('debugLevel', parseInt(args.query.level));
		}
		
		callback({ code: 0 });
	}
	
	logs_worker(args, callback) {
		// send log command to worker (change debug level, etc.)
		// args.query: { pool, pid, echo, level }
		this.logDebug(5, "Changing worker debug log settings", args.query);
		
		var pool = this.pm.getPool( args.query.pool );
		if (!pool) return this.doError(1, "Pool not found: " + args.query.pool, callback);
		
		var worker = pool.getWorker( args.query.pid );
		if (!worker) return this.doError(1, "Worker not found: " + args.query.pid, callback);
		
		args.query.action = 'update_debug';
		worker.sendInternal(args.query);
		
		callback({ code: 0 });
	}
	
	stop_inspector() {
		// shut down inspector listener
		if (this.inspector) {
			this.logDebug(2, "Shutting down debug inspector");
			
			this.server.logger.set('echo', !!this.server.config.get('echo'));
			this.server.logger.echoer = null;
			this.server.logger.set('debugLevel', this.origDebugLevel);
			delete this.origDebugLevel;
			
			this.inspector.close();
			delete this.inspector;
			delete this.server.Inspector;
			
			// remove globals we added
			for (var key in this.globals) {
				delete global[key];
			}
		}
	}
	
	handler_stop(args, callback) {
		// stop debugging
		if (!this.require_auth(args, callback)) return;
		// if (args.query.pool && args.query.pid) return this.stop_worker(args, callback);
		
		this.stop_all();
		callback({ code: 0 });
	}
	
	stop_all() {
		// stop ALL debuggers in ALL processes
		if (this.pm) {
			var pools = this.pm.getPools();
			
			for (var pool_id in pools) {
				var pool = pools[pool_id];
				var workers = pool.getWorkers();
				
				for (var pid in workers) {
					var worker = workers[pid];
					worker.sendInternal({ action: 'stop_debug' });
				} // foreach worker
			} // foreach pool
		} // pm
		
		// stop debugger in this process as well
		this.stop_inspector();
		
		delete this.debuggerEnabled;
		delete this.lastPing;
	}
	
	/* stop_worker(args, callback) {
		// stop debugging in pool worker
		this.logDebug(5, "Stopping debugger in worker ", args.query);
		
		var pool = this.pm.getPool( args.query.pool );
		if (!pool) return this.doError(1, "Pool not found: " + args.query.pool, callback);
		
		var worker = pool.getWorker( args.query.pid );
		if (!worker) return this.doError(1, "Worker not found: " + args.query.pid, callback);
		
		args.query.action = 'stop_debug';
		worker.sendInternal(args.query);
		
		callback({ code: 0 });
	} */
	
	doError(code, msg, callback) {
		// log error and send api response
		assert( arguments.length == 3, "Wrong number of arguments to doError" );
		this.logError( code, msg );
		callback({ code: code, description: msg });
		return false;
	}
	
	maint() {
		// check for dead man's switch (ping death)
		// (called every minute)
		var now = Tools.timeNow(true);
		
		if (this.debuggerEnabled && ((now - this.lastPing) >= 300)) {
			this.logDebug(3, "No ping received in last 5 minutes, stopping all debuggers");
			this.stop_all();
		}
	}
	
	shutdown(callback) {
		// shutdown debug service
		this.stop_inspector();
		callback();
	}
	
});
