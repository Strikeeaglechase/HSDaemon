import chalk from "chalk";
import { ChildProcess, exec } from "child_process";
import { config } from "dotenv";
import { v4 as uuidv4 } from "uuid";
import WebSocket from "ws";

config();
interface Packet {
	type: string;
	pid?: string;
	data?: any;
}

interface DaemonReport {
	seenSmLeaveMessage: boolean;
	seenLobbyCreationFailedMessage: boolean;
	lastHighAverageTick: number;
	exceptionSeen: boolean;
	lastRestart: number;
	lastUserJoinAttempt: number;
	lastUserJoinSuccess: number;
	lastLogMessage: number;

	lastCommandedServerStart: number;
	lastServerStop: number;
}

const ENABLE_START = true;

class Daemon {
	private hsProcess: ChildProcess;
	private seenSmLeaveMessage = false;
	private seenLobbyCreationFailedMessage = false;
	private lastHighAverageTick = 0;
	private exceptionSeen = false;
	private lastRestart = 0;
	private lastUserJoinAttempt = 0;
	private lastUserJoinSuccess = 0;
	private lastLogMessage = 0;

	private lastCommandedServerStart = 0;
	private lastServerStop = 0;

	private allowedToStart = ENABLE_START;
	constructor() { }

	public startProcess() {
		if (!this.allowedToStart) return;
		this.lastCommandedServerStart = Date.now();
		// console.log(`dotnet ${process.env.HS_PATH}`);
		this.hsProcess = exec(`dotnet ${process.env.HS_PATH}`, { cwd: process.env.HS_DIR });
		this.hsProcess.stdout.on("data", (data) => this.processHSMessage(data));
		this.hsProcess.stderr.on("data", (data) => console.log(chalk.red(data)));

		this.hsProcess.on("close", (code) => {
			this.lastServerStop = Date.now();
			console.log(`HS process exited with code ${code}`);
			this.clearState();
			this.startProcess();
		});

		this.hsProcess.on("error", (err) => {
			console.log(`HS process error: ${err}`);
			this.clearState();
			this.startProcess();
		});
	}

	public shutdownGracefully() {
		if (this.hsProcess) this.hsProcess.stdin.write("q\n");
	}

	public shutdownWithoutRestart() {
		this.allowedToStart = false;
		this.shutdownGracefully();
	}

	private processHSMessage(message: string) {
		if (message.includes("\n")) {
			message.split("\n").forEach(part => this.processHSMessage(part.trim()));
			return;
		}

		if (!message || message.length == 0) return;

		if (message.includes(`[ERROR]`)) console.log(chalk.red(message));
		else if (message.includes(`[WARN]`)) console.log(chalk.yellow(message));
		else console.log(message);


		if (message.includes("SM Leave")) this.seenSmLeaveMessage = true;
		if (message.includes("Lobby creation failed")) this.seenLobbyCreationFailedMessage = true;
		if (message.includes("High average tick time")) this.lastHighAverageTick = Date.now();
		if (message.toLowerCase().includes("exception")) this.exceptionSeen = true;
		if (message.includes("Restarting server...")) this.lastRestart = Date.now();
		if (message.includes("Join request for")) this.lastUserJoinAttempt = Date.now();
		if (message.includes("A client is connecting ID")) this.lastUserJoinSuccess = Date.now();
		this.lastLogMessage = Date.now();
	}

	private clearState() {
		this.seenSmLeaveMessage = false;
		this.seenLobbyCreationFailedMessage = false;
		this.lastHighAverageTick = 0;
		this.exceptionSeen = false;
		this.lastRestart = 0;
		this.lastUserJoinAttempt = 0;
		this.lastUserJoinSuccess = 0;
	}

	public getReport(): DaemonReport {
		console.log("Sending report");
		return {
			seenSmLeaveMessage: this.seenSmLeaveMessage,
			seenLobbyCreationFailedMessage: this.seenLobbyCreationFailedMessage,
			lastHighAverageTick: this.lastHighAverageTick,
			exceptionSeen: this.exceptionSeen,
			lastRestart: this.lastRestart,
			lastUserJoinAttempt: this.lastUserJoinAttempt,
			lastUserJoinSuccess: this.lastUserJoinSuccess,
			lastCommandedServerStart: this.lastCommandedServerStart,
			lastServerStop: this.lastServerStop,
			lastLogMessage: this.lastLogMessage,
		};
	}
}

class Application {
	private ws: WebSocket;
	private isConnected = false;
	private daemon: Daemon;
	private hasShutdown = false;

	constructor() {
		this.daemon = new Daemon();
	}

	private configureWs() {
		if (this.isConnected) {
			console.log("WS connection already opened");
			return;
		}

		console.log(`Connecting to ${process.env.WS_URL}`);

		this.ws = new WebSocket(process.env.WS_URL);

		this.ws.on("open", () => {
			console.log(`WS connection opened`);
			this.isConnected = true;
			this.send({ type: "authenticate_daemon", data: { token: process.env.WS_TOKEN } });
		});

		this.ws.on("error", (err) => console.log(`WS error: ${err}`));

		this.ws.on("close", () => {
			console.log(`WS connection closed. Retrying in 1s`);
			this.isConnected = false;
			setTimeout(() => this.configureWs(), 1000);
		});

		this.ws.on("message", (data) => {
			this.handleMessage(data.toString());
		});
	}

	private handleMessage(message: string) {
		try {
			const packet = JSON.parse(message) as Packet;
			switch (packet.type) {
				case "ping": this.send({ type: "pong" }); break;
				case "daemon_restart": this.daemon.shutdownGracefully(); break;
				case "daemon_report_request": this.send({ type: "daemon_report", data: this.daemon.getReport() }); break;
			}

		} catch (e) {
			console.log(`Error parsing packet: ${message}`);
			console.log(e);
		}
	}

	public send<T extends Packet>(data: T) {
		if (!this.isConnected) {
			console.log(`Unable to send packet ${data.type} - not connected`);
			return;
		};
		const result = { pid: uuidv4(), ...data };
		this.ws.send(JSON.stringify(result));
	}

	public async init() {
		this.configureWs();
		this.daemon.startProcess();
	}

	public onExit() {
		if (this.hasShutdown) {
			process.exit();
		}

		console.log("Exiting...");
		this.daemon.shutdownWithoutRestart();
		this.hasShutdown = true;
		setTimeout(() => process.exit(0), 500);
	}
}

const app = new Application();
app.init();



process.on('exit', () => app.onExit());
process.on('SIGINT', () => app.onExit());
process.on('SIGUSR1', () => app.onExit());
process.on('SIGUSR2', () => app.onExit());
process.on('uncaughtException', () => app.onExit());
