/**
 * cc-compiler - Compiler.ts
 * The main compiler
 * 
 * Author: Carl Ian Voller
 */

import EventEmitter from "event-emitter-es6";
import { exec } from "child_process";
import { spawn, IPty } from "node-pty";
import { CompilerOptions } from "../types";
import compilers from "./langList.json";

class Compiler extends EventEmitter {

    opts: CompilerOptions;
    folderName: string;
    process?: IPty;
    checkInterval?: NodeJS.Timeout;

    /**
     * Creates a compiler instance.
     * @param {CompilerOptions} opts - Options object
     * @param {Number} opts.langNum - Index of Language to compile file in
     * @param {String} opts.mainFile - File to execute on compilation
     * @param {String} opts.pathToFiles - Absolute path to location of files
     * @param {String} opts.containerName	- Name of docker container
     * @param {String} opts.folderName (OPTIONAL) - Name of folder where files are stored within the container. If left blank, "code" is used instead. 
     */
    constructor(opts: CompilerOptions) {
        super();

        // Parameter checks
        if ((!opts.langNum && opts.langNum !== 0) || typeof opts.langNum !== "number") throw "Required param 'langNum' missing or invalid.";
        if (!opts.mainFile || typeof opts.mainFile !== "string") throw "Required param 'mainFile' missing or invalid.";
        if (!opts.pathToFiles || typeof opts.pathToFiles !== "string") throw "Required param 'pathToFiles' missing or invalid.";
        if (!opts.containerName || typeof opts.containerName !== "string") throw "Required param 'containerName' missing or invalid.";

        this.opts = opts;
        this.folderName = opts.folderName || "code";
    }

    
    /**
     * Compilation function 
     */
    exec() {
        const runner = compilers[this.opts.langNum];
        exec(`chmod -R 777 ${this.opts.pathToFiles};chown -R cc-user:cc-user /usercode`);

        // Arguments for docker run command
        let args = ["run", "--rm", "--name", this.opts.containerName, "-e", "TERM=xterm-256color", "--cpus=0.25", "--memory=200m",
                    "-itv", `${this.opts.pathToFiles}:/usercode/${this.opts.folderName}`, "--workdir", `/usercode/${this.opts.folderName}`, "cc-compiler", "/bin/bash"];
        
        // Creates a pseudo-tty shell (For colours, arrow keys and other basic terminal functionalities)
        this.process = spawn("docker", args, { name: 'xterm-256color', cols: 32, rows: 200 });

        // Used for certain step2 commands
        let _ = this.opts.mainFile.split("."); _.pop();
        let fileWithoutExt = _.join(".");
        
        // Handles automatic terminal logic such as sending run commands
        let arrow = "\u001b[1;3;31m>> \u001b[0m",
            step1 = `${runner[0]} ${this.opts.mainFile}\r`,
            step2 = runner[1] ? `${runner[1].replace("{}", fileWithoutExt)}\r` : "",
            sentStep1 = false,
            sentStep2 = !step2, // If there isn't a step2 command, we assume it has already been sent
            receivedFinalArrow = false;
        
        
        // Handles terminal output and stdin
        this.process.onData((e) => {

            this.emit("inc", { out: e });

            // Stop container once all steps have been sent and program is done.
            if(e.includes(arrow) && sentStep1 && sentStep2) { return exec(`docker rm -f ${this.opts.containerName}`); }
        
            if(!sentStep1 && e === arrow) {
                return setTimeout(() => {
                    if(sentStep1) { return; }
                    sentStep1 = true;
                    this.process?.write(step1);
                }, 100);
            }
    
            if(!sentStep2 && sentStep1 && e.includes(arrow)) {
                return setTimeout(() => {
                    if(sentStep2) { return; }
                    sentStep2 = true;
                    this.process?.write(step2);
                }, 100);
            }
    
            // Undo any stdin writen between steps if there is a step2.
            if(!sentStep2 && sentStep1 && !e.includes(arrow) || receivedFinalArrow) {
                return this.process?.write(String.fromCharCode(127));
            }
        });

        let isLaunched = false,     // Has the docker container started
            sentDone = false;       // Has the "done" event been emitted, if so, don't send another one.
        
        this.checkInterval = setInterval(() => {
            // Check if docker container is still running
            exec(`docker ps | grep ${this.opts.containerName}`, (_: any, out: string) => {
    
                // Checks if docker container has been launched. If so, emit launched event.
                if (out && !isLaunched) { isLaunched = !0; this.emit("launched"); return; }
    
                // Timeout code execution after one minute.
                let timedOut = out.indexOf("minute") > -1;
                if (((!out && isLaunched) || timedOut) && !sentDone) {
    
                    this.emit("done", { out: "", timedOut: timedOut });
                    sentDone = true;
                        
                    return this._cleanUp();
                }
            });
        }, 500);
    }

    /**
     * Handles STDIN to the running program.
     * @param {string} text - Text to push to the program
     */
    push (text: string) {
        try { this.process?.write(text); } catch(e) { console.warn(e); }
    }

    // Stops compilation and kills the docker process
    stop () {
        try { this.process?.kill("1"); } catch(e) { console.warn(e); }           // Kill processes
        setTimeout(() => exec(`docker rm -f ${this.opts.containerName}`), 200); // Remove docker container
    }

    // Resizes pseudo-tty
    resize({ cols, rows }: { cols: number, rows: number }) {
        try { this.process?.resize(cols, rows); } catch(e) { console.warn(e); }
    }

    // Cleans up after compilation ends.
    _cleanUp() {
        if(this.checkInterval) { clearInterval(this.checkInterval); }
        try { this.process?.kill("1"); } catch(e) {}
    }
}

export default Compiler;