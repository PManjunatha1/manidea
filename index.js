const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        success: true,
        app: "ManIdea Cashfree Backend",
        status: "Running",
        version: "1.0.0"
    });
});

const createOrder = require("./api/create-order");
const verifyPayment = require("./api/verify-payment");

app.use("/api", createOrder);
app.use("/api", verifyPayment);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});