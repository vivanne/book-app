require('dotenv').config();
const express = require("express");
const { Liquid } = require('liquidjs');
const axios = require("axios");
const { google } = require('googleapis');
const session = require('express-session');

const app = express();
const port = 3000;

// Maak een nieuwe Liquid renderer
const engine = new Liquid();

// Stel Liquid als templating engine in
app.engine('liquid', engine.express());
app.set('view engine', 'liquid');
app.set('views', './views');

app.use(express.static('public'));

// Configuratie voor Google OAuth 2.0
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID, // Je client ID van Google API Console
  process.env.CLIENT_SECRET, // Je client secret van Google API Console
  'http://localhost:3000/auth/callback' // De redirect URI die je hebt ingesteld in Google Console
);

// De URL om naar Google in te loggen
const SCOPES = ['https://www.googleapis.com/auth/books'];

app.use(session({
  secret: 'your-secret',
  resave: false,
  saveUninitialized: true
}));

// ---------- AUTHENTICATION ----------------
// Stap 1: Gebruiker wordt doorgestuurd naar Google om in te loggen
app.get('/auth', (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline', // Zorg ervoor dat je offline toegang krijgt, zodat je een refresh token kunt krijgen
        scope: SCOPES // Geef aan welke gegevens je wilt inzien, hier: toegang tot boeken
    });
    res.redirect(url);
});


// Stap 2: Callback URL van Google na inloggen
app.get('/auth/callback', async (req, res) => {
    const { code } = req.query;

    try {
        // Verkrijg toegangstoken
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        // Sla tokens op in de sessie
        req.session.tokens = tokens;

        res.redirect('/');
    } catch (error) {
        console.error('Fout bij het verkrijgen van tokens:', error);
        res.status(500).send('Fout bij het verkrijgen van toegangstoken');
    }
});

// get recommendations--------

async function getRecommendedBooks(currentlyReading, haveRead) {
    // Combineer beide lijsten van boeken
    let allBooks = [...currentlyReading, ...haveRead];

    if (allBooks.length === 0) {
        return []; // Geen aanbevelingen als er geen boeken gelezen worden
    }

    let recommendations = [];
    let seenTitles = new Set();

    for (let book of allBooks) {
        let title = book.volumeInfo.title;
        let author = book.volumeInfo.authors ? book.volumeInfo.authors[0] : null;
        let genre = book.volumeInfo.categories ? book.volumeInfo.categories[0] : null;

        try {
            // Zoek boeken van dezelfde auteur
            if (author && !seenTitles.has(author)) {
                let authorResponse = await axios.get(`https://www.googleapis.com/books/v1/volumes?q=inauthor:"${author}"&maxResults=3`);
                recommendations.push(...(authorResponse.data.items || []));
                seenTitles.add(author);
            }

            // Zoek boeken uit hetzelfde genre
            if (genre && !seenTitles.has(genre)) {
                let genreResponse = await axios.get(`https://www.googleapis.com/books/v1/volumes?q=subject:${genre}&maxResults=3`);
                recommendations.push(...(genreResponse.data.items || []));
                seenTitles.add(genre);
            }

            // Zoek gerelateerde boeken op basis van de titel
            if (!seenTitles.has(title)) {
                let relatedResponse = await axios.get(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(title)}&maxResults=3`);
                recommendations.push(...(relatedResponse.data.items || []));
                seenTitles.add(title);
            }

        } catch (error) {
            console.error(`Fout bij ophalen van aanbevelingen voor ${title}:`, error);
        }
    }

    // Verwijder dubbele boeken uit de aanbevelingen
    let uniqueRecommendations = [];
    let seenBookTitles = new Set();

    for (let book of recommendations) {
        if (!seenBookTitles.has(book.volumeInfo.title)) {
            uniqueRecommendations.push(book);
            seenBookTitles.add(book.volumeInfo.title);
        }
    }

    return uniqueRecommendations.slice(0, 10); // Maximaal 10 unieke aanbevelingen
}




// ---------- HOME SCREEN -------------

app.get("/", async (req, res) => {
    if (!req.session.tokens) {
        return res.redirect('/auth');
    }

    try {
        oauth2Client.setCredentials(req.session.tokens);
        const booksApi = google.books({ version: 'v1', auth: oauth2Client });

        // Haal alle boekenplanken op
        const bookshelfResponse = await booksApi.mylibrary.bookshelves.list();
        const bookshelves = bookshelfResponse.data.items || [];

        // async function getBooksFromShelf(shelfId) {
        //     try {
        //         const response = await booksApi.mylibrary.bookshelves.volumes.list({ shelf: shelfId });
        //         return response.data.items || [];
        //     } catch (error) {
        //         console.error(`Fout bij ophalen van boeken van plank ${shelfId}:`, error);
        //         return [];
        //     }
        // }

        async function getBooksFromShelf(shelfId) {
            let books = [];
            let nextPageToken = null;
            
            try {
                do {
                    const response = await booksApi.mylibrary.bookshelves.volumes.list({
                        shelf: shelfId,
                        maxResults: 40, // Google Books API ondersteunt max 40 per keer
                        pageToken: nextPageToken
                    });
        
                    if (response.data.items) {
                        books.push(...response.data.items);
                    }
        
                    nextPageToken = response.data.nextPageToken;
                } while (nextPageToken); // Ga door zolang er meer pagina's zijn
        
                return books;
            } catch (error) {
                console.error(`Fout bij ophalen van boeken van plank ${shelfId}:`, error);
                return [];
            }
        }
        

        // Haal Currently Reading boeken (ID 3) op
        const currentlyReadingBooks = await getBooksFromShelf(3);

        // Haal Gelezen boeken (ID 4) op
        const haveReadBooks = await getBooksFromShelf(4);

        // Haal aanbevelingen op op basis van both 'currently reading' en 'have read'
        let recommendedBooks = await getRecommendedBooks(currentlyReadingBooks, haveReadBooks);

        res.render("index", {
            currentlyReading: currentlyReadingBooks,
            haveRead: haveReadBooks,
            recommendedBooks: recommendedBooks,
            books: []
        });

    } catch (error) {
        console.error("Fout bij ophalen boeken:", error);
        res.render("index", { books: [], error: "Kon geen boeken ophalen." });
    }
});

// add to shelve

app.use(express.urlencoded({ extended: true }));

app.post("/add-to-shelf", async (req, res) => {
    if (!req.session.tokens) {
        return res.redirect("/auth");
    }

    const { bookId, shelf } = req.body;
    oauth2Client.setCredentials(req.session.tokens);
    const booksApi = google.books({ version: "v1", auth: oauth2Client });

    try {
        await booksApi.mylibrary.bookshelves.addVolume({
            shelf: shelf, // De plank-ID (3 = Currently Reading, 4 = Have Read)
            volumeId: bookId
        });

        res.redirect("/"); // Terug naar home na toevoegen
    } catch (error) {
        console.error("Fout bij toevoegen aan plank:", error);
        res.status(500).send("Kon boek niet toevoegen aan plank.");
    }
});


// ---------- SEARCH BAR ----------------

app.get("/search", async (req, res) => {
    const query = req.query.q;

    if (!query) {
        return res.render("index", { books: [], error: "Voer een zoekterm in!", currentlyReading: req.session.currentlyReading || [] });
    }

    try {
        const response = await axios.get(`https://www.googleapis.com/books/v1/volumes?q=${query}`);
        const books = response.data.items || [];

        res.render("index", {
            books,
            error: null,
            currentlyReading: req.session.currentlyReading || [] // Zorg ervoor dat de 'currently reading' boeken behouden blijven
        });
    } catch (error) {
        console.error("Fout bij ophalen boeken:", error);
        res.render("index", {
            books: [],
            error: "Kon geen boeken ophalen.",
            currentlyReading: req.session.currentlyReading || []
        });
    }
});

// ---------- SERVER STARTEN -------------
app.listen(port, () => {
    console.log(`Server draait op http://localhost:${port}`);
});
