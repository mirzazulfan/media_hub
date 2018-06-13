// HTTP service serves file meta data and the file itself
import http from "http";
import { URL } from "url";
import * as Fs from "fs";
import * as Util from "util";
import * as Path from "path";

import logger from "../utils/log";

let readdir = Util.promisify(Fs.readdir);

export default class HTTPService {
    constructor(metaData, port) {
        if (!metaData) {
            logger.error("MetaData object not passed to HTTPService.");
            throw Error("MetaData object not passed to HTTPService.");
        }
        if (!port) {
            logger.error("Port not passed to HTTPService.");
            throw Error("Port not passed to HTTPService.");
        }

        this.metaData = metaData;
        this.port = port;

        this.server = http.createServer(this.rootHandler.bind(this));
        this.server
            .on("clientError", (err, socket) => {
                logger.error(`HTTPService: clientError`);
                logger.debug(`HTTPService: ${err.stack}`);

                logger.info(`HTTPService: Closing socket`);
                socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
            })
            .on("listening", () => {
                let addr = this.server.address();
                logger.info(
                    `HTTPService: listening on ${addr.address}:${addr.port}`
                );
            })
            .on("error", err => {
                logger.error(`UDPService: ${err}`);
                logger.debug(`UDPService: ${err.stack}`);
            })
            .on("close", () => {
                logger.info("HTTPService: Service stopped");
            });
    }

    // Starts the service
    start() {
        logger.debug("HTTPService: Start function called");
        this.server.listen(this.port);
    }

    // Stops the service
    stop() {
        logger.debug("HTTPService: Stop function called");
        this.server.close();
    }

    // Handles all incoming requests
    async rootHandler(req, res) {
        try {
            let addr = req.socket.address();
            logger.info(
                `HTTPService: Request at ${req.url} from ${addr.address}:${
                    addr.port
                }`
            );
            this.validateRequest(req);

            // If request is for meta data pass request to metaDataHandler
            // The request handlers may be async so use await to catch errors
            if (req.path.length === 2) {
                await this.metaDataRequestHandler(req, res);
            } else {
                // Else serve file
                await this.fileRequestHandler(req, res);
            }
        } catch (err) {
            if (err.code === 404) {
                res.statusCode = 404;
                res.statusMessage = err.toString();
            } else {
                logger.error(`HTTPService: ${err}`);
                logger.debug(`HTTPService: ${err.stack}`);
                res.statusCode = 500;
            }
            res.end();
        }
    }

    // Serves metaData of file
    metaDataRequestHandler(req, res) {
        let data = this.metaData.getData(
            this.metaData.getPathFromId(req.path[0])
        );

        // Create new object
        data = { ...data };
        // Don't send path in response
        delete data.path;
        data = JSON.stringify(data, null, 0);

        res.writeHead(200, {
            "Content-Type": "application/json"
        });
        res.write(data);
        res.end();
    }

    // Serves the file
    fileRequestHandler(req, res) {
        let data = this.metaData.getData(
            this.metaData.getPathFromId(req.path[0])
        );
        let path = data.path;

        // If directory return directory listing
        if (data.type === "dir") {
            return readdir(path).then(children => {
                children = children.map(child => Path.join(path, child));

                // Get list of children
                let listing = [];
                children.forEach(child => {
                    if (this.metaData.hasFile(child)) {
                        let chdata = this.metaData.getData(child);
                        listing.push({ name: chdata.name, id: chdata.id });
                    }
                });

                let response = {
                    id: req.path[0],
                    children: listing
                };
                response = JSON.stringify(response, null, 0);

                res.writeHead(200, {
                    "Content-Type": "application/json"
                });
                res.write(response);
                res.end();
            });
        }

        // Path is a file
        res.writeHead(200, {
            "Content-Type": "application/octet-stream"
        });
        let fileStream = Fs.createReadStream(path);
        fileStream.pipe(res);
        this.metaData.incrementDownload(path);
    }

    // Validates URL
    // Only URL of type `/:fileId` or `/:fileId/meta` where fileId exists in
    // metaData is allowed. Else error is thrown by function.
    // It also pareses URL and assigns the JS object to req.url. It also adds
    // a path property which is an array of resources in the URL.
    validateRequest(req) {
        let path = req.url;
        // Remove initial '/' char
        path = path.slice(1);
        if (path.endsWith("/")) path = path.slice(0, path.length - 1);
        req.path = path.split("/");

        if (
            req.path.length > 2 ||
            (req.path.length === 2 && req.path[1] !== "meta")
        ) {
            let x = new Error("Invalid URL");
            x.code = 404;
            throw x;
        }

        // Check if file with id exists in db
        if (!this.metaData.getPathFromId(req.path[0])) {
            let x = new Error("Resource not found");
            x.code = 404;
            throw x;
        }
    }
}