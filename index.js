import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const app = express();
const port = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());

const uri = `mongodb+srv://${process.env.DB_USER}:${encodeURIComponent(process.env.DB_PASSWORD)}@cluster0.93riodr.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri);

export async function connectToMongoDB() {
    try {
        await client.connect();
        console.log("You successfully connected to MongoDB!");
        return client;
    } catch (err) {
        console.dir(err);
    }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("salonbookdb");
const users = database.collection("user");

app.get('/', (req, res) => {
    res.send('connected');
});

app.get('/user', async (req, res) => {
    try {
        const result = await users.find({}).toArray();
        res.json(result);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ message: 'Failed to fetch users' });
    }
});

app.listen(port, () => {
    console.log(`salon running on port ${port}`);
});