const path = require('path')

const CompilerError = require('!errors/CompilerError')
const CONFIG = require('!config/mc')
const File = require('!io/File')
const { evaluateCodeWithEnv } = require('./code-runner')
const crypto = require('crypto')
const fs = require('fs')
const yaml = require("./js-yaml")

let env
let _fakefs = new Set()

function evaluate(line) {
	if (line.indexOf('<%') > -1 && line.indexOf('%>')) {
		const template = line
			.replace(/\${/g, '${"${"}')
			.replace(/\\/g, '\\\\')
			.replace(/<%/g, '${')
			.replace(/%>/g, '}')
			.replace(/\`/g, '\\`')
		try {
			return evaluateCodeWithEnv('return `' + template + '`', env)
		} catch (e) {
			console.log(e)
			throw new CompilerError(`invalid template literal '${template}'`)
		}
	}
	return line
}

class MultiFile {
	constructor(file) {
		this.segments = {}
	}
	set(id, func) {
		this.segments[id] = this.segments[id] || []
		this.segments[id].push(func)
	}
	values() {
		return Object.values(this.segments).flat()
	}
	valuesFor(key) {
		return Object.values(this.segments[key] || {}).flat(Infinity)
	}
	reset(file) {
		delete this.segments[file]
	}
}

class MultiFileTag {
	constructor(path) {
		this.segments = {}
		this.file = new File()
		this.file.setPath(path)
		this.current = false
	}
	set(id, func) {
		if (!this.current) {
			this.file.confirm()
			this.current = true
		}
		this.segments[id] = this.segments[id] || []
		this.segments[id].push(func)
		this.file.setContents(
			JSON.stringify({
				replace: false,
				values: Object.values(this.segments).flat(Infinity),
			})
		)
	}
	reset(file) {
		this.current = false
		delete this.segments[file]
		if (!this.current) {
			this.file.confirm()
			this.current = true
		}
		this.file.setContents(
			JSON.stringify({
				replace: false,
				values: Object.values(this.segments).flat(Infinity),
			})
		)
	}
}
const tickFile = new File()
tickFile.setPath(
	path.resolve(process.cwd(), './addon/functions/' + CONFIG.generatedDirectory + '/events/tick.mcfunction')
)
const tickFunction = new MultiFile(tickFile)
const loadFile = new File()
loadFile.setPath(
	path.resolve(process.cwd(), './addon/functions/' + CONFIG.generatedDirectory + '/events/load.mcfunction')
)
const loadFunction = new MultiFile(loadFile)

class MCFunction extends File {
	constructor(parent, top, intent) {
		super()
		this.parent = parent
		this.top = top || this
		this.functions = []
		this.namespace = 'lang_error'
		this._path = Math.random().toString(36).substr(2)
		this.target = this
		this.intent = intent
	}
	getHash() {
		const c = crypto.createHash('md5').update(this.functions.join('\n'))
		return c.digest('hex')
	}
	addCommand(command) {
		this.functions.push(evaluate(command))
	}
	setPath(p) {
		this._path = p
	}
	getReference() {
		return this.namespace + '/' + this._path
	}
	getContents() {
		return (
			(CONFIG.header ? CONFIG.header + '\n\n' : '') +
			this.functions
				.map(command =>
					command
						.replace(/\$block/g, this.namespace + '/' + this.getFunctionPath())
						.replace(/\$top/g, this.top.getReference())
						.replace(/\$parent/g, () => {
							if (this.parent) {
								return this.parent.getReference()
							} else {
								throw new CompilerError('$parent used where there is no valid parent.')
							}
						})
				)
				.join('\n')
		)
	}
	getPath() {
		return path.resolve(process.cwd(), './addon/functions/', this.namespace, this._path + '.mcfunction')
	}
	getFunctionPath() {
		return this._path
	}

	confirm(file) {
		if (!_fakefs.has(this._path)) {
			_fakefs.add(this._path)
			if (this.intent === 'load') {
				loadFunction.set(file, this.getReference())
			} else if (this.intent === 'tick') {
				tickFunction.set(file, this.getReference())
			}
			super.confirm()
		}
	}
	toString() {
		return 'function ' + this.namespace + '/' + this.getFunctionPath()
	}

	static setEnv(_env) {
		_fakefs = new Set()
		env = _env
	}
}

class RealFile extends File {
	async getContents() {
		return this._contents = await fs.readFileSync(this._path, 'utf-8')
	}
	async setContents(contents) {
		this._contents = contents
		return await fs.writeFileSync(this._path, this._contents)
	}
}

async function mcmetaToManifest(metapath, manifestpath, logger=console) {
	// DEFAULTS
	const pack_mcmeta = {
		pack: {
			pack_format: 15,
			description: "A generated datapack"
		}
	}
	const manifest_json = {
		format_version: 2,
		header: {
			name: path.basename(path.dirname(metapath)) ?? "my addon name", // Should remove pack.mcmeta first and then get the folder name
			description: "A generated addon",
			uuid: ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16)),
			version: [1, 0, 0],
			min_engine_version: [1, 16, 0]
		},
		metadata: {
			generated_with: { "build-mc": ["1.0.0"] }
		}
	}

	// https://minecraft.fandom.com/wiki/Pack_format -> Array.from(document.querySelectorAll("#mw-content-text > div > table:nth-child(11) tr")).splice(1).map((r)=>[r.children[0].innerText, r.children[2].innerText]).filter(m=>m[1]!="—")
	const packformats = [["4","1.13–1.14.4"],["5","1.15–1.16.1"],["6","1.16.2–1.16.5"],["7","1.17–1.17.1"],["8","1.18–1.18.1"],["9","1.18.2"],["10","1.19–1.19.3"],["12","1.19.4"],["15","1.20"]]

	// get files
	const metaFile = new RealFile()
	metaFile.setPath(metapath)
	const manifestFile = new RealFile()
	manifestFile.setPath(manifestpath)

	// Content assign to the default variable
	const thisMcmeta = await metaFile.getContents()
	if (typeof(thisMcmeta) != 'undefined') {
		try {
			Object.assign(pack_mcmeta, JSON.parse(thisMcmeta))
		} catch (e) {
			try {
				Object.assign(pack_mcmeta, yaml.load(thisMcmeta))
			} catch (e2) {
				logger.error('Parsing pack.mcmeta didn\'t work!', e, e2)
			}
		}
	}

	const thisManifest = await manifestFile.getContents()
	if (typeof(thisManifest) != 'undefined') {
		try {
			Object.assign(manifest_json, JSON.parse(thisManifest))
		} catch (e) {
			logger.error('Parsing manifest.json didn\'t work', e)
		}
	}

	// Convert pack_format to min_engine_version
	let mev = packformats.find((p)=>p[0]==pack_mcmeta.pack.pack_format); // find matching thing
	if (mev) mev = mev[1]?.split("–"); // split - from 1.18-1.18.20
	if (mev && mev.length == 1) mev = [mev[0], mev[0]]; // just for less code, we make it 2 pieces
	if (mev) mev = mev[1]?.split('.'); // split . from 1.18.20
	if (mev) mev = mev.map((s)=>Number(s)); // convert string to int
	if (mev && mev.length == 2) mev = [...mev, 0]; // add trailing 0
	if (!mev) mev = manifest_json.header.min_engine_version;

	// convert meta to manifest (it is just 2 things...)
	Object.assign(manifest_json.header, {
		description: pack_mcmeta.pack.description,
		min_engine_version: mev
	})

	// save manifest
	logger.info('saving manifest', manifestpath)
	manifestFile.setContents(JSON.stringify(manifest_json, null, '\t'));
}

module.exports = {
	MCFunction,
	tickFunction,
	loadFunction,
	loadFile,
	tickFile,
	evaluate_str: evaluate,
	MultiFileTag,
	mcmetaToManifest,
}
