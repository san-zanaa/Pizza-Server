import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';

const app = express()
const port = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());

const client = new MongoClient("mongodb://<db_username>:<db_password>@ac-ha0c8ps-shard-00-00.83xnhwr.mongodb.net:27017,ac-ha0c8ps-shard-00-01.83xnhwr.mongodb.net:27017,ac-ha0c8ps-shard-00-02.83xnhwr.mongodb.net:27017/?ssl=true&replicaSet=atlas-276hdv-shard-0&authSource=admin");
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
const database = connectedClient.db("pizzahub");
const user = database.collection("user");

app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})