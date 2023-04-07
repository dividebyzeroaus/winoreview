const openai = require('openai');
const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");
const express = require('express');
const bodyParser = require('body-parser');
const sql = require('mssql');
const app = express();

app.use(bodyParser.json());

app.post('/generate-review', async (req, res) => {
  try {
    const varietal = req.body.varietal;
    const region = req.body.region;
    const persona = req.body.persona;

    // Check if the persona parameter is valid
    const validPersonas = ["newcomer", "novice", "connoisseur"];
    if (!validPersonas.includes(persona)) {
      throw new Error(`Invalid persona '${persona}'. Expected one of: ${validPersonas.join(', ')}`);
    }

    // Load API key from Azure Key Vault
    const credential = new DefaultAzureCredential();
    const url = `https://${process.env.KEYVAULT_NAME}.vault.azure.net`;
    const client = new SecretClient(url, credential);
    const api_key = await client.getSecret(process.env.OPENAI_SECRET_NAME).then((secret) => secret.value);

    // Configure the OpenAI API client
    openai.apiKey = api_key;

    // Define the prompts for each persona
    const prompts = {
      "newcomer": `Generate a wine review for someone who has never had ${varietal} from ${region}.`,
      "novice": `Generate a wine review for someone who is new to ${varietal} from ${region}.`,
      "connoisseur": `Generate a wine review for someone who is familiar with ${varietal} from ${region}.`
    };

    // Get the appropriate prompt based on the persona
    const prompt = prompts[persona];

    // Check if the prompt has already been used before
    const pool = await sql.connect({
      server: process.env.SQL_SERVER_NAME,
      database: process.env.SQL_DATABASE_NAME,
      user: process.env.SQL_USERNAME,
      password: process.env.SQL_PASSWORD,
      encrypt: true
    });
    const result = await pool.request()
      .input('prompt', sql.NVarChar, prompt)
      .query('SELECT review FROM reviews WHERE prompt = @prompt');
    if (result.recordset.length > 0) {
      // Prompt has been used before, return the stored review
      const review = result.recordset[0].review;
      res.json({ review: review });
      return;
    }

    // Prompt has not been used before, generate a new review using the OpenAI API
    const response = await openai.Completion.create({
      engine: "text-davinci-002",
      prompt: prompt,
      temperature: 0.5,
      maxTokens: 1024,
      n: 1,
      stop: null,
      frequencyPenalty: 0,
      presencePenalty: 0
    });

    // Extract the review text from the OpenAI API response
    let review = response.choices[0].text.trim();

    // Clean up the review text by removing extra line breaks and whitespace
    review = review.replace(/\n\n+/g, '\n\n').trim();

    // Store the prompt and review in the database for future use
    await pool.request()
      .input('prompt', sql.NVarChar, prompt)
      .input('review', sql.NVarChar, review)
      .query('INSERT INTO reviews (prompt, review) VALUES (@prompt, @review)');

    res.json({ review: review });

// Close the SQL connection pool
await sql.close();

} catch (error) {
console.error(error);
res.status(500).json({ error: error.message });
}
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
console.log('Listening on port ${port}');
});