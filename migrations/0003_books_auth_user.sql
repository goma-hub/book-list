-- Discard practice records and replace the development-only user schema.
DROP TABLE books;
DROP TABLE users;

CREATE TABLE books (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  author TEXT,
  finished_on TEXT,
  photo_url TEXT,
  memo TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES "user"(id)
);

CREATE INDEX idx_books_user_id ON books(user_id);
