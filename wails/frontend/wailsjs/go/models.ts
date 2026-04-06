export namespace main {
	
	export class LogEntry {
	    time: string;
	    text: string;
	    type: string;
	
	    static createFrom(source: any = {}) {
	        return new LogEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.time = source["time"];
	        this.text = source["text"];
	        this.type = source["type"];
	    }
	}
	export class UserSession {
	    id: string;
	    email: string;
	    access_token: string;
	
	    static createFrom(source: any = {}) {
	        return new UserSession(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.email = source["email"];
	        this.access_token = source["access_token"];
	    }
	}

}

