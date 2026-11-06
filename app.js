
const express = require("express");
const session = require("express-session");
const path = require("path");
const bcrypt = require("bcryptjs");
const db = require("./db");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: "carenest-development-secret-change-before-deployment",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000
    }
}));

app.use(express.static(path.join(__dirname, "public")));

function requireLogin(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({ message: "Please login first." });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.user || req.session.user.role !== "admin") {
        return res.status(403).json({ message: "Admin access required." });
    }
    next();
}

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/session", (req, res) => {
    res.json({ user: req.session.user || null });
});

// CUSTOMER REGISTRATION
app.post("/api/register", async (req, res) => {
    try {
        const { name, email, phone, password } = req.body;

        if (!name || !email || !phone || !password) {
            return res.status(400).json({ message: "Please fill all fields." });
        }

        if (password.length < 6) {
            return res.status(400).json({ message: "Password must contain at least 6 characters." });
        }

        const [existing] = await db.execute(
            "SELECT user_id FROM users WHERE email = ?",
            [email]
        );

        if (existing.length) {
            return res.status(409).json({ message: "Email already registered." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        await db.execute(
            "INSERT INTO users (name,email,password,phone,role) VALUES (?,?,?,?,?)",
            [name, email, hashedPassword, phone, "customer"]
        );

        res.status(201).json({ message: "Registration successful. Please login." });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Registration failed." });
    }
});

// LOGIN
app.post("/api/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        const [users] = await db.execute(
            "SELECT * FROM users WHERE email = ?",
            [email]
        );

        if (!users.length) {
            return res.status(401).json({ message: "Invalid email or password." });
        }

        const user = users[0];
        const valid = await bcrypt.compare(password, user.password);

        if (!valid) {
            return res.status(401).json({ message: "Invalid email or password." });
        }

        req.session.user = {
            user_id: user.user_id,
            name: user.name,
            email: user.email,
            role: user.role
        };

        res.json({
            message: "Login successful.",
            user: req.session.user
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Login failed." });
    }
});

// LOGOUT
app.post("/api/logout", (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).json({ message: "Logout failed." });
        }
        res.clearCookie("connect.sid");
        res.json({ message: "Logged out successfully." });
    });
});

// MEDICINES
app.get("/api/medicines", async (req, res) => {
    try {
        const search = `%${req.query.search || ""}%`;

        const [medicines] = await db.execute(
            `SELECT * FROM medicines
             WHERE medicine_name LIKE ?
             AND stock > 0
             AND expiry_date >= CURDATE()
             ORDER BY medicine_name`,
            [search]
        );

        res.json(medicines);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Unable to load medicines." });
    }
});

// PLACE ORDER
app.post("/api/checkout", requireLogin, async (req, res) => {
    const { name, email, phone, items } = req.body;

    if (!name || !email || !phone || !Array.isArray(items) || !items.length) {
        return res.status(400).json({ message: "Enter customer details and add medicines to cart." });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [userRows] = await connection.execute(
            "SELECT user_id FROM users WHERE user_id = ?",
            [req.session.user.user_id]
        );

        if (!userRows.length) {
            throw new Error("Customer account not found.");
        }

        let total = 0;
        const orderItems = [];

        for (const item of items) {
            const quantity = Number(item.quantity);
            const medicineId = Number(item.medicine_id);

            if (!Number.isInteger(quantity) || quantity < 1 ||
                !Number.isInteger(medicineId) || medicineId < 1) {
                throw new Error("Invalid medicine or quantity.");
            }

            const [rows] = await connection.execute(
                `SELECT medicine_id, medicine_name, price, stock
                 FROM medicines
                 WHERE medicine_id = ? AND expiry_date >= CURDATE()
                 FOR UPDATE`,
                [medicineId]
            );

            if (!rows.length) {
                throw new Error("A medicine is unavailable or expired.");
            }

            const medicine = rows[0];

            if (medicine.stock < quantity) {
                throw new Error("Insufficient stock for " + medicine.medicine_name);
            }

            const price = Number(medicine.price);
            total += price * quantity;

            orderItems.push({
                medicine_id: medicine.medicine_id,
                quantity,
                price
            });
        }

        const [orderResult] = await connection.execute(
            `INSERT INTO orders (user_id,total_amount,status)
             VALUES (?,?,?)`,
            [req.session.user.user_id, total, "Pending"]
        );

        const orderId = orderResult.insertId;

        for (const item of orderItems) {
            await connection.execute(
                `INSERT INTO order_items
                 (order_id,medicine_id,quantity,price)
                 VALUES (?,?,?,?)`,
                [orderId, item.medicine_id, item.quantity, item.price]
            );

            await connection.execute(
                "UPDATE medicines SET stock = stock - ? WHERE medicine_id = ?",
                [item.quantity, item.medicine_id]
            );
        }

        await connection.commit();

        res.status(201).json({
            message: "Order placed successfully!",
            order_id: orderId,
            total_amount: total
        });

    } catch (err) {
        await connection.rollback();
        console.error(err);
        res.status(400).json({ message: err.message || "Order failed." });
    } finally {
        connection.release();
    }
});

// CUSTOMER ORDER HISTORY
app.get("/api/my-orders", requireLogin, async (req, res) => {
    try {
        const [orders] = await db.execute(
            `SELECT o.order_id, o.order_date, o.total_amount, o.status,
                    oi.item_id, oi.quantity, oi.price,
                    m.medicine_name
             FROM orders o
             LEFT JOIN order_items oi ON o.order_id = oi.order_id
             LEFT JOIN medicines m ON oi.medicine_id = m.medicine_id
             WHERE o.user_id = ?
             ORDER BY o.order_date DESC`,
            [req.session.user.user_id]
        );

        res.json(orders);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Unable to load orders." });
    }
});

// ADMIN DASHBOARD DATA
app.get("/api/admin", requireAdmin, async (req, res) => {
    try {
        const [medicines] = await db.execute(
            "SELECT * FROM medicines ORDER BY medicine_id DESC"
        );

        const [orders] = await db.execute(
            `SELECT o.*, u.name, u.email, u.phone
             FROM orders o
             JOIN users u ON o.user_id = u.user_id
             ORDER BY o.order_date DESC`
        );

        const [stats] = await db.execute(
            `SELECT
                (SELECT COUNT(*) FROM medicines) AS medicineCount,
                (SELECT COUNT(*) FROM orders) AS orderCount,
                (SELECT COUNT(*) FROM users WHERE role='customer') AS customerCount,
                (SELECT COALESCE(SUM(total_amount),0)
                 FROM orders WHERE status <> 'Cancelled') AS revenue`
        );

        res.json({ medicines, orders, stats: stats[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Unable to load dashboard." });
    }
});

// ADD MEDICINE
app.post("/api/admin/medicine", requireAdmin, async (req, res) => {
    try {
        const { medicine_name, manufacturer, price, stock, expiry_date } = req.body;

        if (!medicine_name || !expiry_date ||
            !Number.isFinite(Number(price)) || Number(price) < 0 ||
            !Number.isInteger(Number(stock)) || Number(stock) < 0 ||
            !/^\d{4}-\d{2}-\d{2}$/.test(expiry_date)) {
            return res.status(400).json({ message: "Enter valid medicine details." });
        }

        await db.execute(
            `INSERT INTO medicines
             (medicine_name,manufacturer,price,stock,expiry_date)
             VALUES (?,?,?,?,?)`,
            [medicine_name, manufacturer || "", Number(price), Number(stock), expiry_date]
        );

        res.status(201).json({ message: "Medicine added successfully." });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Unable to add medicine." });
    }
});

// UPDATE MEDICINE
app.put("/api/admin/medicine/:id", requireAdmin, async (req, res) => {
    try {
        const { medicine_name, manufacturer, price, stock, expiry_date } = req.body;

        if (!medicine_name || !expiry_date ||
            !Number.isFinite(Number(price)) || Number(price) < 0 ||
            !Number.isInteger(Number(stock)) || Number(stock) < 0 ||
            !/^\d{4}-\d{2}-\d{2}$/.test(expiry_date)) {
            return res.status(400).json({ message: "Enter valid medicine details." });
        }

        const [result] = await db.execute(
            `UPDATE medicines SET
             medicine_name=?, manufacturer=?, price=?, stock=?, expiry_date=?
             WHERE medicine_id=?`,
            [medicine_name, manufacturer || "", Number(price),
             Number(stock), expiry_date, req.params.id]
        );

        if (!result.affectedRows) {
            return res.status(404).json({ message: "Medicine not found." });
        }

        res.json({ message: "Medicine updated successfully." });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Unable to update medicine." });
    }
});

// DELETE MEDICINE
app.delete("/api/admin/medicine/:id", requireAdmin, async (req, res) => {
    try {
        const [result] = await db.execute(
            "DELETE FROM medicines WHERE medicine_id=?",
            [req.params.id]
        );

        if (!result.affectedRows) {
            return res.status(404).json({ message: "Medicine not found." });
        }

        res.json({ message: "Medicine deleted successfully." });
    } catch (err) {
        res.status(400).json({
            message: "Cannot delete a medicine already included in an order."
        });
    }
});

// UPDATE ORDER STATUS
app.patch("/api/admin/order/:id", requireAdmin, async (req, res) => {
    try {
        const allowed = ["Pending", "Processing", "Delivered", "Cancelled"];
        const { status } = req.body;

        if (!allowed.includes(status)) {
            return res.status(400).json({ message: "Invalid order status." });
        }

        const [result] = await db.execute(
            "UPDATE orders SET status=? WHERE order_id=?",
            [status, req.params.id]
        );

        if (!result.affectedRows) {
            return res.status(404).json({ message: "Order not found." });
        }

        res.json({ message: "Order status updated." });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Unable to update order." });
    }
});

// CUSTOMER MANAGEMENT
app.get("/api/admin/customers", requireAdmin, async (req, res) => {
    try {
        const [customers] = await db.execute(
            `SELECT user_id, name, email, phone, role
             FROM users ORDER BY user_id DESC`
        );
        res.json(customers);
    } catch (err) {
        res.status(500).json({ message: "Unable to load customers." });
    }
});

// ORDER ITEM DETAILS
app.get("/api/admin/order/:id/items", requireAdmin, async (req, res) => {
    try {
        const [items] = await db.execute(
            `SELECT oi.*, m.medicine_name
             FROM order_items oi
             JOIN medicines m ON oi.medicine_id=m.medicine_id
             WHERE oi.order_id=?`,
            [req.params.id]
        );
        res.json(items);
    } catch (err) {
        res.status(500).json({ message: "Unable to load order items." });
    }
});

const PORT = 3000;

app.listen(PORT, () => {
    console.log(`CareNest Pharmacy running at http://localhost:${PORT}`);
});
