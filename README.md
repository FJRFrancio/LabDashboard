## InstrumentManager

InstrumentManager is a FastAPI + SQLModel laboratory instrument reservation and sample management system that also ships with a read-only public board for quick status checks.

### Getting started
1. (Optional) create and activate a virtual environment  
   ``python -m venv .venv && .\.venv\Scripts\activate``
2. Install dependencies  
   ``pip install -r requirements.txt``
3. Start the service (default port 8000)  
   ``uvicorn main:app --reload --host 0.0.0.0 --port 8000``

Starting the server will automatically create `app.db` and seed a default administrator:
- Username: ``admin``
- Password: ``admin123``

### Main pages
- `/login`: Login / registration page.
- `/dashboard`: Instrument dashboard for logged-in users (scheduling controls visible after authentication).
- `/reservations`: Reservation submission interface.
- `/samples`: Sample management (upload TGA/BET/PXRD images).
- `/profile`: Personal profile maintenance.
- `/admin-board`: Administrator area (instrument management, reservation option management, scheduling).
- `/board`: Public instrument board (read-only, auto-refreshes, no login required).

### Public endpoints (no authentication)
- `GET /api/public/instruments/status`: Instrument board data.

### Authentication endpoints
- `POST /api/login` / `POST /api/register` / `POST /api/logout`
- `GET /api/me` / `PUT /api/me`: Profile information.

### Core business endpoints
- Instruments: `/api/instruments` (GET/POST), `/api/instruments/{id}` (PUT/DELETE), `/api/instruments/status`, `/api/instruments/{id}/reservations`, `/api/instruments/{id}/reserve`, `/api/instruments/{id}/insert` (super admin only, inserts a priority slot and shifts future bookings).
- Reservations: `/api/reservations/{id}` (DELETE).
- Samples: `/api/samples` (GET/POST), `/api/samples/{id}` (PUT/DELETE).
- Reservation options: `/api/options` (GET/POST).
- Submissions: `/api/submissions` (GET for staff / POST for users), `/api/submissions/my`, `/api/submissions/{id}` (detail for staff), `/api/submissions/{id}/status` (staff edit).
- Uploads: `/api/upload/{kind}` where ``kind`` supports ``avatars``, ``tga``, ``bet``, and ``pxrd``.

### Front-end resources
- Templates: `templates/login.html`, `templates/app.html`, `templates/public_board.html`
- Scripts: `static/login.js`, `static/app.js` (post-login UI), `static/public.js` (public board)
- Styling: `static/style.css`
- Uploaded files land in `static/uploads/{avatars,tga,bet,pxrd}`

### Data models (SQLModel)
- `User` (includes `role`, profile fields, `photo_url`)
- `Instrument` / `Reservation`
- `Sample`
- `ReservationOption` / `OptionSubmission` / `SubmissionSampleLink`
- `InstrumentAdminLink`

### Key features
- Administrators can create instruments and reservation options, view all submissions, and schedule reservations.
- The scheduling board surfaces submission details (user notes, linked samples) and lets staff view sample images (TGA/BET/PXRD; shows “no data” if missing).
- Regular users can submit reservations, manage their samples, and update their profile.
- The public board at `/board` provides a read-only, auto-refreshing view that can be displayed fullscreen on a local network without logging in.

### Default files/directories
- `main.py`: FastAPI app entrypoint with models, routes, and helpers.
- `requirements.txt`: Dependency list.
- `templates/`: Jinja2 views.
- `static/`: Static assets plus the uploads directory.
- `app.db`: SQLite database (auto-generated on startup).

### Notes
- Uploaded images are served from paths like `/static/uploads/<kind>/<filename>`.
- To reset data, stop the service, delete `app.db`, and restart; the database and default admin user will be recreated automatically.
