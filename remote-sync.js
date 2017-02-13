// imports
const crypto     = require("crypto"),       // needed to create the md5 checksum to check for actual changes to a file and not just overwriting the file
      fs         = require("fs"),           // needed to read files from the local file system
      chokidar   = require("chokidar"),     // file-watcher
      nconf      = require("nconf"),        // configuration
      Client     = require("ssh2").Client;

// configuration file for various options, username/password, etc.
nconf.file({file: "config.json"});

// path to the local build directory
var localPath  = nconf.get("localPath"),

// path to the source root on the remote server
    remotePath = nconf.get("sftp:remotePath"),

// this holds the list of md5 hashes for the source files to determine if they have changed
    hashes  = [],

// holds references for files that need updates
    updates = {},

// holds a reference to a setTimeout instance used for sftp file writes
    timeout,

// ready state variable for when the sftp connection is ready to transfer files
    sftp_ready = false,

// ready state variable for when the filewatcher is ready to start watching
    watcher_ready = false,

// connection object
    conn;

// code to perform cleanup on exiting because of pressing CTRL + C
// this process runs "indefinitely", so unless an error occurs, you
// will either need to use CTRL + C or close the shell to end it
process.on("SIGINT", () => {
    console.info("Shutting down...");

    // shut down the sftp connection
    if (sftp_ready) {
        console.info("Closing SFTP connection...");
        conn.end();
    }

    // shut down the file watcher
    if (watcher_ready) {
        console.info("Closing watcher...");
        watcher.close();
    }

    console.info("Exiting application...");
    process.exit();
});

watcher = chokidar.watch(localPath, {
    ignored       : nconf.get("ignore") || /[\/\\]\./,  // can pass in an array of files to ignore in the config or just default to ignoring dot files
    persistent    : true
});

// set up event listeners for watcher
watcher
    .on("ready", () => {

        console.info("************************************************");
        console.info("*  Initial scan complete. Ready for changes.   *");
        console.info("************************************************");

        watcher_ready = true;

    }).on('all', (event, path, stats) => {

        // at the moment we are only interested in the add and change events
        // and eventually the delete event
        //
        // note :: this does not capture 'ready', 'raw' or 'error' events,
        // those must be explicitly defined

        if (["add", "change"].includes(event)) {

            getHash(path, (hash) => {
                var relativePath = getRelativePath(localPath, path);

                // if the hash doesn't exist or the hash exists, but has changed
                if (!hashes[relativePath] || (hashes[relativePath] !== hash)) {

                    // store the updated hash
                    hashes[relativePath] = hash;

                    // we have received the ready event from the file-watcher
                    if (watcher_ready) {

                        // We want to grab as many file updates as possible before we start
                        // writing those files to the server.   We create a timeout below which
                        // we clear every time we have a change we need to write.  When the timeout
                        // is triggered, we take all of those changes and loop through them to send
                        // to the server as a sort of "batched" update.  The timeout value may need
                        // to be adjusted.  The idea is to have enough time on the timeout to allow
                        // all of the changes to be gathered during a build and when the build is
                        // finished, write those changes to the server all at once.

                        // If a timeout has been set, clear it.
                        if (timeout) {
                            clearTimeout(timeout);
                        }

                        console.info("INFO :: file has changed", path.replace(/^.*[\\\/]/, '')); // regex here just strips off the path and leaves only the filename

                        // Add this files path, so we can loop through this objects "path" properties later for our writes
                        updates[path] = relativePath;

                        timeout = setTimeout(() => {
                            conn = connectToSFTPServer();

                            conn.on("ready", () => {
                                conn.sftp((err, sftp) => {

                                    if (err) {
                                        console.error(err);
                                    }

                                    process.stdout.write("Writing files to sftp server ");

                                    for (let path in updates) {
                                        if (updates.hasOwnProperty(path)) {

                                            sftp.fastPut(path, remotePath + updates[path], (err) => {
                                               if (err) {
                                                   // note :: need some sort of recovery here, if the write fails
                                                   // we still need to write this file, assuming the error is an
                                                   // error we can recover from
                                                   console.error(err);
                                               }
                                            });

                                        }
                                    }

                                    process.stdout.write("........................ done" + '\n');

                                    // Done writing files, need to empty the updates object so it will be ready
                                    // for the next collection of files.
                                    updates = {};
                                });
                            });

                        // Some experimentation may be needed here to figure out the optimum wait
                        // period for this timeout.  5 seconds seems like a pretty good start though.
                        }, 5 /* seconds */ * 1000 /* milliseconds */);

                    }
                }
            })
        }
    });


/**
 * Helper function to set up a connection to our remote server environment.  This is
 * the server we will be serving our html from.  We establish this connection so we
 * can "upload" updated files during the build process on our local machine to our
 * remote machine.  This will keep the two environments in sync in an automated fashion
 *
 * @returns {Client} Our client connection object that we will be using to make sftp calls
 */
function connectToSFTPServer(){
    let conn    = new Client(),
        spinner = [
            '|',
            '/',
            '-',
            '\\'
        ],
        attempts = 0,

        // connections settings for the sftp file transfer
        connSettings = {
            host     : nconf.get("sftp:host"),
            port     : nconf.get("sftp:port"),
            username : nconf.get("sftp:username"),
            password : nconf.get("sftp:password")
    };

    conn.on("ready", () => {
        sftp_ready = true;
        attempts = 0;
    }).on("error", () => {
        // In case we have been connected, but are now somehow disconnected
        // set this flag back to false.
        // note :: this is set to true in the "ready" event handler
        sftp_ready = false;

        process.stdout.write("Unable to communicate with sftp server. Retrying " + spinner[attempts++ % 4] + "\x1b[0G"); // works like /r, but will work on windows

        // attempt to connect to the server
        conn.connect(connSettings);
    });

    // attempt to connect to the server
    conn.connect(connSettings);

    // return the connection object so we can use it elsewhere
    return conn;
}

/**
 * Creates an md5 hash from a file
 *
 * @param {String} path The path to the file we want to create an md5 hash for
 * @param {Function} callback The callback/function, passing in the md5 hash
 */
function getHash(path, callback) {
    let stream = fs.ReadStream(path),
        md5sum = crypto.createHash("md5");

    stream
        .on("data", (data) => {
            md5sum.update(data);
        }).on("end", () => {
            callback(md5sum.digest("hex"));
        });
}

/**
 * Strips the root from the given full path to return only the portion of the path that will be common
 * between both the local and remote source files.  This method will also convert backslashes to forward
 * slashes.
 *
 * @param {String} root The document root, either local or remote, that represents the "variable" part of the path
 * @param {String} fullPath The full path to a file, including the root, witch will be stripped out for the return
 * @returns {String} The path that will be the same between local an remote environments
 */
function getRelativePath(root, fullPath) {
    return fullPath.substring(root.length, fullPath.length).replace(/\\/g,"/");
}
