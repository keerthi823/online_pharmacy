

const mysql = require("mysql2");

const db = mysql.createPool({
    host: "localhost",
    user: "root",
    password: "keerthi",
    database: "pharmacy_db",
    waitForConnections: true,
    connectionLimit: 10
});

module.exports = db.promise();
