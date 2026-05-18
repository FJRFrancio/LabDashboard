import os
import shutil
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import List, Optional
from uuid import uuid4

from fastapi import Cookie, Depends, FastAPI, File, Header, HTTPException, Request, Response, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from passlib.context import CryptContext
from sqlmodel import Field, Relationship, SQLModel, Session, create_engine, select, not_

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./app.db")
SECRET_KEY = os.getenv("APP_SECRET", "dev-secret-key")
SESSION_COOKIE = "session"
UPLOAD_ROOT = Path("static") / "uploads"
KIND_DIRS = {"avatars": "avatars", "tga": "tga", "bet": "bet", "pxrd": "pxrd"}

ROLE_SUPER_ADMIN = "super_admin"
ROLE_INSTRUMENT_ADMIN = "instrument_admin"
ROLE_USER = "user"

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
serializer = URLSafeTimedSerializer(SECRET_KEY)
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})


# ----------------------------
# Models
# ----------------------------

class InstrumentAdminLink(SQLModel, table=True):
    instrument_id: int = Field(foreign_key="instrument.id", primary_key=True)
    user_id: int = Field(foreign_key="user.id", primary_key=True)


class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(index=True, unique=True)
    full_name: Optional[str] = None
    org: Optional[str] = None
    grade: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    photo_url: Optional[str] = None
    role: str = Field(default=ROLE_USER)  # user | instrument_admin | super_admin
    password_hash: str

    samples: List["Sample"] = Relationship(back_populates="owner")
    reservations: List["Reservation"] = Relationship(back_populates="user")
    instrument_admin: List["Instrument"] = Relationship(
        back_populates="admins", link_model=InstrumentAdminLink
    )


class Instrument(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True)
    status: str = Field(default="normal")  # normal | maintenance | fault | offline
    description: Optional[str] = None

    admins: List[User] = Relationship(
        back_populates="instrument_admin", link_model=InstrumentAdminLink
    )
    reservations: List["Reservation"] = Relationship(back_populates="instrument")


class Reservation(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    instrument_id: int = Field(foreign_key="instrument.id")
    user_id: int = Field(foreign_key="user.id")
    start_date: date
    end_date: date
    note: Optional[str] = None
    status: str = Field(default="scheduled")  # scheduled | completed | cancelled

    instrument: Instrument = Relationship(back_populates="reservations")
    user: User = Relationship(back_populates="reservations")


class Sample(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id")
    name: str
    remark: Optional[str] = None
    tga_image: Optional[str] = None
    bet_image: Optional[str] = None
    pxrd_image: Optional[str] = None

    owner: User = Relationship(back_populates="samples")


class ReservationOption(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True)
    require_tga: bool = True
    require_pxrd: bool = True
    require_bet: bool = True
    created_by: Optional[int] = Field(default=None, foreign_key="user.id")


class OptionSubmission(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id")
    option_id: int = Field(foreign_key="reservationoption.id")
    instrument_preference: Optional[str] = None  # "ASAP" or instrument name
    remark: Optional[str] = None
    status: str = Field(default="submitted")  # submitted | scheduled | completed | cancelled
    instrument_assigned_id: Optional[int] = Field(default=None, foreign_key="instrument.id")
    scheduled_start: Optional[date] = None
    scheduled_end: Optional[date] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class SubmissionSampleLink(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    submission_id: int = Field(foreign_key="optionsubmission.id")
    sample_id: int = Field(foreign_key="sample.id")
    note: Optional[str] = None


# ----------------------------
# Helpers
# ----------------------------

def create_db_and_tables():
    SQLModel.metadata.create_all(engine)


def ensure_upload_dirs():
    for sub in KIND_DIRS.values():
        (UPLOAD_ROOT / sub).mkdir(parents=True, exist_ok=True)


def get_session():
    with Session(engine) as session:
        yield session


def canonical_role_value(role: str) -> str:
    if role == "admin":
        return ROLE_SUPER_ADMIN
    return role or ROLE_USER


def ensure_canonical_role(user: Optional[User]) -> Optional[User]:
    if user:
        user.role = canonical_role_value(user.role)
    return user


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    return pwd_context.verify(password, hashed)


def create_token(user: User) -> str:
    return serializer.dumps(
        {"sub": user.id, "role": canonical_role_value(user.role)}
    )


def resolve_token(raw_token: str) -> dict:
    try:
        return serializer.loads(raw_token, max_age=60 * 60 * 24 * 7)  # 7 days
    except SignatureExpired:
        raise HTTPException(status_code=401, detail="Session expired")
    except BadSignature:
        raise HTTPException(status_code=401, detail="Invalid login credentials")


def maybe_current_user(
    session: Session = Depends(get_session),
    cookie_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    auth_header: Optional[str] = Header(default=None, alias="Authorization"),
) -> Optional[User]:
    token = None
    if auth_header and auth_header.startswith("Bearer "):
        token = auth_header[7:]
    elif cookie_token:
        token = cookie_token
    if not token:
        return None
    try:
        payload = resolve_token(token)
        return ensure_canonical_role(session.get(User, payload.get("sub")))
    except Exception:
        return None


def get_current_user(
    session: Session = Depends(get_session),
    cookie_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    auth_header: Optional[str] = Header(default=None, alias="Authorization"),
) -> User:
    token = None
    if auth_header and auth_header.startswith("Bearer "):
        token = auth_header[7:]
    elif cookie_token:
        token = cookie_token
    if not token:
        raise HTTPException(status_code=401, detail="Please log in first")
    payload = resolve_token(token)
    user = ensure_canonical_role(session.get(User, payload.get("sub")))
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def require_super_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != ROLE_SUPER_ADMIN:
        raise HTTPException(status_code=403, detail="Super administrator privileges required")
    return user


def require_staff(user: User = Depends(get_current_user)) -> User:
    if user.role not in (ROLE_SUPER_ADMIN, ROLE_INSTRUMENT_ADMIN):
        raise HTTPException(status_code=403, detail="Administrator privileges required")
    return user


def user_can_manage_instrument(user: User, instrument_id: int, session: Session) -> bool:
    if user.role == ROLE_SUPER_ADMIN:
        return True
    if user.role != ROLE_INSTRUMENT_ADMIN:
        return False
    link = session.get(InstrumentAdminLink, (instrument_id, user.id))
    return link is not None


def ensure_no_overlap(
    session: Session,
    instrument_id: int,
    start_date: date,
    end_date: date,
    exclude_reservation_id: Optional[int] = None,
):
    statement = select(Reservation).where(
        Reservation.instrument_id == instrument_id,
        Reservation.status != "cancelled",
    )
    if exclude_reservation_id:
        statement = statement.where(Reservation.id != exclude_reservation_id)
    for r in session.exec(statement).all():
        if start_date <= r.end_date and end_date >= r.start_date:
            raise HTTPException(status_code=400, detail="This time slot conflicts with an existing reservation; please choose another")


def build_instrument_status(session: Session):
    today = date.today()
    instruments = session.exec(select(Instrument)).all()
    result = []
    for inst in instruments:
        reservations = session.exec(
            select(Reservation, User)
            .where(Reservation.instrument_id == inst.id, Reservation.status != "cancelled")
            .join(User, User.id == Reservation.user_id)
            .order_by(Reservation.start_date)
        ).all()
        current = None
        next_one = None
        for res, u in reservations:
            if res.start_date <= today <= res.end_date and not current:
                current = (res, u)
            elif res.start_date > today and not next_one:
                next_one = (res, u)
        result.append(
            {
                "id": inst.id,
                "name": inst.name,
                "status": inst.status,
                "current": None
                if not current
                else {
                    "user": current[1].full_name or current[1].username,
                    "photo_url": current[1].photo_url,
                    "start": str(current[0].start_date),
                    "end": str(current[0].end_date),
                    "note": current[0].note,
                },
                "next": None
                if not next_one
                else {
                    "user": next_one[1].full_name or next_one[1].username,
                    "start": str(next_one[0].start_date),
                    "end": str(next_one[0].end_date),
                },
            }
        )
    return result


def save_upload(kind: str, file: UploadFile) -> str:
    if kind not in KIND_DIRS:
        raise HTTPException(status_code=400, detail="Unsupported upload type")
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]:
        raise HTTPException(status_code=400, detail="Only image files are supported")
    filename = f"{datetime.utcnow().strftime('%Y%m%d%H%M%S%f')}_{uuid4().hex[:6]}{ext}"
    target_dir = UPLOAD_ROOT / KIND_DIRS[kind]
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / filename
    with open(target_path, "wb") as f:
        shutil.copyfileobj(file.file, f)
    return f"/static/uploads/{KIND_DIRS[kind]}/{filename}"


# ----------------------------
# FastAPI app
# ----------------------------

app = FastAPI(title="Lab Instrument Manager")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


@app.on_event("startup")
def on_startup():
    create_db_and_tables()
    ensure_upload_dirs()
    with Session(engine) as session:
        admin = session.exec(select(User).where(User.username == "admin")).first()
        if not admin:
            admin = User(
                username="admin",
                full_name="Administrator",
                email="admin@example.com",
                role=ROLE_SUPER_ADMIN,
                password_hash=hash_password("admin123"),
            )
            session.add(admin)
            session.commit()
        elif admin.role == "admin":
            admin.role = ROLE_SUPER_ADMIN
            session.add(admin)
            session.commit()
        if not session.exec(select(Instrument)).first():
            names = [
                "IGA-002",
                "IGA-100",
                "XEMIS",
                "High Pressure XEMIS",
                "DVS",
                "3Flex",
                "ABR-1",
                "ABR-2",
                "Tristar",
                "IR-DRIFTS",
                "BSD-A",
                "BSD-B",
            ]
            for n in names:
                session.add(Instrument(name=n, status="normal"))
            session.commit()


def render_app_page(page: str, request: Request, user: User) -> HTMLResponse:
    return templates.TemplateResponse(
        "app.html", {"request": request, "page": page, "user": user}
    )


@app.get("/")
def root(request: Request, user: Optional[User] = Depends(maybe_current_user)):
    if user:
        return RedirectResponse("/dashboard", status_code=302)
    return templates.TemplateResponse("login.html", {"request": request})


@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request, user: Optional[User] = Depends(maybe_current_user)):
    if user:
        return RedirectResponse("/dashboard", status_code=302)
    return templates.TemplateResponse("login.html", {"request": request})


@app.get("/dashboard", response_class=HTMLResponse)
def dashboard_page(request: Request, user: User = Depends(get_current_user)):
    return render_app_page("dashboard", request, user)


@app.get("/samples", response_class=HTMLResponse)
def samples_page(request: Request, user: User = Depends(get_current_user)):
    return render_app_page("samples", request, user)


@app.get("/reservations", response_class=HTMLResponse)
def reservations_page(request: Request, user: User = Depends(get_current_user)):
    return render_app_page("reservations", request, user)


@app.get("/profile", response_class=HTMLResponse)
def profile_page(request: Request, user: User = Depends(get_current_user)):
    return render_app_page("profile", request, user)


@app.get("/admin-board", response_class=HTMLResponse)
def admin_board_page(request: Request, admin: User = Depends(require_staff)):
    return render_app_page("admin", request, admin)


@app.get("/personnel", response_class=HTMLResponse)
def personnel_page(request: Request, admin: User = Depends(require_super_admin)):
    return render_app_page("personnel", request, admin)


@app.get("/board", response_class=HTMLResponse)
def public_board(request: Request, session: Session = Depends(get_session)):
    return templates.TemplateResponse("public_board.html", {"request": request})


# ----------------------------
# Upload
# ----------------------------


@app.post("/api/upload/{kind}")
def upload_file(kind: str, file: UploadFile = File(...), user: Optional[User] = Depends(maybe_current_user)):
    url = save_upload(kind, file)
    return {"url": url}


# ----------------------------
# Routes - Auth
# ----------------------------

@app.post("/api/register")
def register(payload: dict, response: Response, session: Session = Depends(get_session)):
    username = payload.get("username")
    password = payload.get("password")
    if not username or not password:
        raise HTTPException(status_code=400, detail="Username and password are required")
    if session.exec(select(User).where(User.username == username)).first():
        raise HTTPException(status_code=400, detail="Username already exists")
    user = User(
        username=username,
        password_hash=hash_password(password),
        full_name=payload.get("full_name"),
        org=payload.get("org"),
        grade=payload.get("grade"),
        phone=payload.get("phone"),
        email=payload.get("email"),
        photo_url=payload.get("photo_url"),
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    token = create_token(user)
    response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax")
    return {"id": user.id, "username": user.username}


@app.post("/api/login")
def login(payload: dict, response: Response, session: Session = Depends(get_session)):
    username = payload.get("username")
    password = payload.get("password")
    user = session.exec(select(User).where(User.username == username)).first()
    if not user or not verify_password(password or "", user.password_hash):
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    token = create_token(user)
    response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax")
    return {"token": token, "role": user.role, "username": user.username}


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(SESSION_COOKIE)
    return {"detail": "logged out"}


@app.get("/api/me")
def me(user: User = Depends(get_current_user)):
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "full_name": user.full_name,
        "email": user.email,
        "org": user.org,
        "grade": user.grade,
        "phone": user.phone,
        "photo_url": user.photo_url,
    }


@app.put("/api/me")
def update_me(payload: dict, session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    user.full_name = payload.get("full_name", user.full_name)
    user.org = payload.get("org", user.org)
    user.grade = payload.get("grade", user.grade)
    user.phone = payload.get("phone", user.phone)
    user.email = payload.get("email", user.email)
    user.photo_url = payload.get("photo_url", user.photo_url)
    session.add(user)
    session.commit()
    session.refresh(user)
    return {"detail": "updated"}


# ----------------------------
# Routes - Instruments
# ----------------------------

@app.get("/api/instruments")
def list_instruments(session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    return session.exec(select(Instrument)).all()


@app.post("/api/instruments")
def create_instrument(payload: dict, session: Session = Depends(get_session), admin: User = Depends(require_super_admin)):
    name = payload.get("name")
    if not name:
        raise HTTPException(status_code=400, detail="Instrument name is required")
    if session.exec(select(Instrument).where(Instrument.name == name)).first():
        raise HTTPException(status_code=400, detail="Instrument already exists")
    inst = Instrument(name=name, status=payload.get("status", "normal"), description=payload.get("description"))
    session.add(inst)
    session.commit()
    session.refresh(inst)
    return inst


@app.put("/api/instruments/{instrument_id}")
def update_instrument(instrument_id: int, payload: dict, session: Session = Depends(get_session), admin: User = Depends(require_super_admin)):
    inst = session.get(Instrument, instrument_id)
    if not inst:
        raise HTTPException(status_code=404, detail="Instrument not found")
    inst.name = payload.get("name", inst.name)
    inst.status = payload.get("status", inst.status)
    inst.description = payload.get("description", inst.description)
    session.add(inst)
    session.commit()
    session.refresh(inst)
    return inst


@app.delete("/api/instruments/{instrument_id}")
def delete_instrument(instrument_id: int, session: Session = Depends(get_session), admin: User = Depends(require_super_admin)):
    inst = session.get(Instrument, instrument_id)
    if not inst:
        raise HTTPException(status_code=404, detail="Instrument not found")
    session.delete(inst)
    session.commit()
    return {"detail": "deleted"}


@app.post("/api/instruments/{instrument_id}/admins")
def assign_instrument_admin(instrument_id: int, payload: dict, session: Session = Depends(get_session), admin: User = Depends(require_super_admin)):
    inst = session.get(Instrument, instrument_id)
    if not inst:
        raise HTTPException(status_code=404, detail="Instrument not found")
    user_id = payload.get("user_id")
    target_user = session.get(User, user_id)
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")
    if canonical_role_value(target_user.role) != ROLE_INSTRUMENT_ADMIN:
        raise HTTPException(status_code=400, detail="The user is not an instrument admin; please promote their role first")
    link = session.get(InstrumentAdminLink, (instrument_id, user_id))
    if not link:
        link = InstrumentAdminLink(instrument_id=instrument_id, user_id=user_id)
        session.add(link)
        session.commit()
    return {"detail": "ok"}


@app.delete("/api/instruments/{instrument_id}/admins/{user_id}")
def remove_instrument_admin(instrument_id: int, user_id: int, session: Session = Depends(get_session), admin: User = Depends(require_super_admin)):
    inst = session.get(Instrument, instrument_id)
    if not inst:
        raise HTTPException(status_code=404, detail="Instrument not found")
    link = session.get(InstrumentAdminLink, (instrument_id, user_id))
    if link:
        session.delete(link)
        session.commit()
    return {"detail": "removed"}


@app.get("/api/instruments/status")
def instrument_status(session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    return build_instrument_status(session)


@app.get("/api/public/instruments/status")
def instrument_status_public(session: Session = Depends(get_session)):
    return build_instrument_status(session)


@app.get("/api/instruments/{instrument_id}/reservations")
def list_reservations(instrument_id: int, session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    inst = session.get(Instrument, instrument_id)
    if not inst:
        raise HTTPException(status_code=404, detail="Instrument not found")
    reservations = session.exec(
        select(Reservation, User)
        .where(Reservation.instrument_id == instrument_id)
        .join(User, User.id == Reservation.user_id)
        .order_by(Reservation.start_date)
    ).all()
    return [
        {
            "id": res.id,
            "user": u.full_name or u.username,
            "start": str(res.start_date),
            "end": str(res.end_date),
            "note": res.note,
            "status": res.status,
        }
        for res, u in reservations
    ]


@app.post("/api/instruments/{instrument_id}/reserve")
def reserve_instrument(instrument_id: int, payload: dict, session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    inst = session.get(Instrument, instrument_id)
    if not inst:
        raise HTTPException(status_code=404, detail="Instrument not found")
    if not user_can_manage_instrument(user, instrument_id, session):
        raise HTTPException(status_code=403, detail="You do not have permission to manage this instrument")
    user_id = payload.get("user_id")
    start_date_str = payload.get("start_date")
    end_date_str = payload.get("end_date")
    note = payload.get("note")
    submission_id = payload.get("submission_id")

    if not (user_id and start_date_str and end_date_str):
        raise HTTPException(status_code=400, detail="user_id, start_date, and end_date are required")
    try:
        start_date_val = date.fromisoformat(start_date_str)
        end_date_val = date.fromisoformat(end_date_str)
    except Exception:
        raise HTTPException(status_code=400, detail="Dates must follow the YYYY-MM-DD format")
    if end_date_val < start_date_val:
        raise HTTPException(status_code=400, detail="End date must be on or after the start date")

    ensure_no_overlap(session, instrument_id, start_date_val, end_date_val)

    reservation = Reservation(
        instrument_id=instrument_id,
        user_id=user_id,
        start_date=start_date_val,
        end_date=end_date_val,
        note=note,
        status="scheduled",
    )
    session.add(reservation)

    if submission_id:
        submission = session.get(OptionSubmission, submission_id)
        if submission:
            submission.status = "scheduled"
            submission.instrument_assigned_id = instrument_id
            submission.scheduled_start = start_date_val
            submission.scheduled_end = end_date_val
            session.add(submission)

    session.commit()
    session.refresh(reservation)
    return {"id": reservation.id}


@app.post("/api/instruments/{instrument_id}/insert")
def insert_reservation(
    instrument_id: int,
    payload: dict,
    session: Session = Depends(get_session),
    admin: User = Depends(require_super_admin),
):
    inst = session.get(Instrument, instrument_id)
    if not inst:
        raise HTTPException(status_code=404, detail="Instrument not found")
    user_id = payload.get("user_id")
    start_date_str = payload.get("start_date")
    days = payload.get("days", 1)
    note = payload.get("note")
    submission_id = payload.get("submission_id")
    if not (user_id and start_date_str):
        raise HTTPException(status_code=400, detail="user_id and start_date are required")
    try:
        start_date_val = date.fromisoformat(start_date_str)
    except Exception:
        raise HTTPException(status_code=400, detail="Dates must follow the YYYY-MM-DD format")
    try:
        days = int(days)
    except Exception:
        raise HTTPException(status_code=400, detail="Days must be an integer")
    if days <= 0:
        raise HTTPException(status_code=400, detail="Day count must be positive")
    shift_delta = timedelta(days=days)
    insert_end = start_date_val + timedelta(days=days - 1)

    future_reservations = session.exec(
        select(Reservation)
        .where(
            Reservation.instrument_id == instrument_id,
            Reservation.status != "cancelled",
            Reservation.end_date >= start_date_val,
        )
        .order_by(Reservation.start_date)
    ).all()

    for res in future_reservations:
        original_start = res.start_date
        original_end = res.end_date
        if res.start_date >= start_date_val:
            res.start_date = res.start_date + shift_delta
            res.end_date = res.end_date + shift_delta
        elif res.start_date < start_date_val <= res.end_date:
            res.end_date = res.end_date + shift_delta
        session.add(res)

        submission = session.exec(
            select(OptionSubmission)
            .where(
                OptionSubmission.instrument_assigned_id == res.instrument_id,
                OptionSubmission.user_id == res.user_id,
                OptionSubmission.scheduled_start == original_start,
                OptionSubmission.scheduled_end == original_end,
            )
        ).first()
        if submission:
            submission.scheduled_start = res.start_date
            submission.scheduled_end = res.end_date
            session.add(submission)

    new_reservation = Reservation(
        instrument_id=instrument_id,
        user_id=user_id,
        start_date=start_date_val,
        end_date=insert_end,
        note=note,
        status="scheduled",
    )
    session.add(new_reservation)

    if submission_id:
        submission = session.get(OptionSubmission, submission_id)
        if submission:
            submission.status = "scheduled"
            submission.instrument_assigned_id = instrument_id
            submission.scheduled_start = start_date_val
            submission.scheduled_end = insert_end
            session.add(submission)

    session.commit()
    session.refresh(new_reservation)
    return {"id": new_reservation.id}


@app.delete("/api/reservations/{reservation_id}")
def delete_reservation(reservation_id: int, session: Session = Depends(get_session), user: User = Depends(require_staff)):
    reservation = session.get(Reservation, reservation_id)
    if not reservation:
        raise HTTPException(status_code=404, detail="Reservation not found")
    if user.role != ROLE_SUPER_ADMIN and not user_can_manage_instrument(user, reservation.instrument_id, session):
        raise HTTPException(status_code=403, detail="You do not have permission to delete this reservation")
    session.delete(reservation)
    submission = session.exec(
        select(OptionSubmission)
        .where(
            OptionSubmission.instrument_assigned_id == reservation.instrument_id,
            OptionSubmission.user_id == reservation.user_id,
            OptionSubmission.scheduled_start == reservation.start_date,
            OptionSubmission.scheduled_end == reservation.end_date,
        )
    ).first()
    if submission:
        submission.status = "submitted"
        submission.instrument_assigned_id = None
        submission.scheduled_start = None
        submission.scheduled_end = None
        session.add(submission)
    session.commit()
    return {"detail": "removed"}


# ----------------------------
# Routes - Samples
# ----------------------------

@app.get("/api/samples")
def list_samples(session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    return session.exec(select(Sample).where(Sample.user_id == user.id)).all()


@app.post("/api/samples")
def create_sample(payload: dict, session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    name = payload.get("name")
    if not name:
        raise HTTPException(status_code=400, detail="Sample name is required")
    sample = Sample(
        name=name,
        user_id=user.id,
        remark=payload.get("remark"),
        tga_image=payload.get("tga_image"),
        bet_image=payload.get("bet_image"),
        pxrd_image=payload.get("pxrd_image"),
    )
    session.add(sample)
    session.commit()
    session.refresh(sample)
    return sample


@app.put("/api/samples/{sample_id}")
def update_sample(sample_id: int, payload: dict, session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    sample = session.get(Sample, sample_id)
    if not sample or sample.user_id != user.id:
        raise HTTPException(status_code=404, detail="Sample not found")
    sample.name = payload.get("name", sample.name)
    sample.remark = payload.get("remark", sample.remark)
    sample.tga_image = payload.get("tga_image", sample.tga_image)
    sample.bet_image = payload.get("bet_image", sample.bet_image)
    sample.pxrd_image = payload.get("pxrd_image", sample.pxrd_image)
    session.add(sample)
    session.commit()
    session.refresh(sample)
    return sample


@app.delete("/api/samples/{sample_id}")
def delete_sample(sample_id: int, session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    sample = session.get(Sample, sample_id)
    if not sample or sample.user_id != user.id:
        raise HTTPException(status_code=404, detail="Sample not found")
    session.delete(sample)
    session.commit()
    return {"detail": "deleted"}


# ----------------------------
# Routes - Reservation Options & Submissions
# ----------------------------

@app.get("/api/options")
def list_options(session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    return session.exec(select(ReservationOption)).all()


@app.post("/api/options")
def create_option(payload: dict, session: Session = Depends(get_session), admin: User = Depends(require_super_admin)):
    name = payload.get("name")
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    if session.exec(select(ReservationOption).where(ReservationOption.name == name)).first():
        raise HTTPException(status_code=400, detail="This reservation option already exists")
    opt = ReservationOption(
        name=name,
        require_tga=payload.get("require_tga", True),
        require_pxrd=payload.get("require_pxrd", True),
        require_bet=payload.get("require_bet", True),
        created_by=admin.id,
    )
    session.add(opt)
    session.commit()
    session.refresh(opt)
    return opt


@app.get("/api/submissions/my")
def my_submissions(session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    rows = session.exec(
        select(OptionSubmission, ReservationOption)
        .where(OptionSubmission.user_id == user.id)
        .join(ReservationOption, ReservationOption.id == OptionSubmission.option_id)
        .order_by(OptionSubmission.created_at.desc())
    ).all()
    result = []
    for sub, opt in rows:
        reservation_id = None
        if sub.instrument_assigned_id and sub.scheduled_start and sub.scheduled_end:
            reservation_match = session.exec(
                select(Reservation)
                .where(
                    Reservation.instrument_id == sub.instrument_assigned_id,
                    Reservation.user_id == sub.user_id,
                    Reservation.start_date == sub.scheduled_start,
                    Reservation.end_date == sub.scheduled_end,
                )
            ).first()
            if reservation_match:
                reservation_id = reservation_match.id
        result.append(
            {
                "id": sub.id,
                "option_name": opt.name,
                "instrument_preference": sub.instrument_preference,
                "status": sub.status,
                "scheduled_start": sub.scheduled_start,
                "scheduled_end": sub.scheduled_end,
                "instrument_assigned_id": sub.instrument_assigned_id,
                "remark": sub.remark,
                "created_at": sub.created_at,
                "reservation_id": reservation_id,
            }
        )
    return result


@app.get("/api/submissions")
def list_all_submissions(session: Session = Depends(get_session), admin: User = Depends(require_staff)):
    rows = session.exec(
        select(OptionSubmission, ReservationOption, User)
        .join(ReservationOption, ReservationOption.id == OptionSubmission.option_id)
        .join(User, User.id == OptionSubmission.user_id)
        .order_by(OptionSubmission.created_at.desc())
    ).all()
    result = []
    for sub, opt, usr in rows:
        sample_links = session.exec(select(SubmissionSampleLink).where(SubmissionSampleLink.submission_id == sub.id)).all()
        reservation_id = None
        if sub.instrument_assigned_id and sub.scheduled_start and sub.scheduled_end:
            reservation_match = session.exec(
                select(Reservation)
                .where(
                    Reservation.instrument_id == sub.instrument_assigned_id,
                    Reservation.user_id == sub.user_id,
                    Reservation.start_date == sub.scheduled_start,
                    Reservation.end_date == sub.scheduled_end,
                )
            ).first()
            if reservation_match:
                reservation_id = reservation_match.id
        result.append(
            {
                "id": sub.id,
                "user": usr.full_name or usr.username,
                "user_id": usr.id,
                "option_name": opt.name,
                "instrument_preference": sub.instrument_preference,
                "status": sub.status,
                "samples": len(sample_links),
                "remark": sub.remark,
                "reservation_id": reservation_id,
                "scheduled_start": sub.scheduled_start,
                "scheduled_end": sub.scheduled_end,
            }
        )
    return result


@app.get("/api/submissions/{submission_id}")
def submission_detail(
    submission_id: int,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    sub = session.get(OptionSubmission, submission_id)
    if not sub:
        raise HTTPException(status_code=404, detail="Submission record not found")
    if user.role not in (ROLE_SUPER_ADMIN, ROLE_INSTRUMENT_ADMIN) and sub.user_id != user.id:
        raise HTTPException(status_code=403, detail="Administrator privileges required")
    user = session.get(User, sub.user_id)
    opt = session.get(ReservationOption, sub.option_id)
    samples_links = session.exec(
        select(SubmissionSampleLink, Sample)
        .where(SubmissionSampleLink.submission_id == submission_id)
        .join(Sample, Sample.id == SubmissionSampleLink.sample_id)
    ).all()
    samples = []
    for link, sample in samples_links:
        samples.append(
            {
                "id": sample.id,
                "name": sample.name,
                "remark": sample.remark,
                "tga_image": sample.tga_image,
                "bet_image": sample.bet_image,
                "pxrd_image": sample.pxrd_image,
                "note": link.note,
            }
        )
    return {
        "id": sub.id,
        "user": user.full_name or user.username if user else None,
        "user_id": sub.user_id,
        "option": opt.name if opt else None,
        "instrument_preference": sub.instrument_preference,
        "remark": sub.remark,
        "status": sub.status,
        "instrument_assigned_id": sub.instrument_assigned_id,
        "scheduled_start": sub.scheduled_start,
        "scheduled_end": sub.scheduled_end,
        "created_at": sub.created_at,
        "samples": samples,
    }


@app.post("/api/submissions")
def create_submission(payload: dict, session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    option_id = payload.get("option_id")
    samples = payload.get("samples", [])
    instrument_preference = payload.get("instrument_preference") or "ASAP"
    remark = payload.get("remark")

    option = session.get(ReservationOption, option_id)
    if not option:
        raise HTTPException(status_code=404, detail="Reservation option not found")

    existing = session.exec(
        select(OptionSubmission)
        .where(
            OptionSubmission.user_id == user.id,
            OptionSubmission.option_id == option_id,
            OptionSubmission.status.notin_(["rejected", "completed"]),
        )
    ).first()
    if existing:
        raise HTTPException(
            status_code=400,
            detail="You already have an active submission for this reservation option; wait for it to be rejected or completed before submitting again",
        )

    for item in samples:
        sample = session.get(Sample, item.get("sample_id"))
        if not sample:
            raise HTTPException(status_code=400, detail="Sample does not exist or does not belong to the current user")
        if option.require_tga and not sample.tga_image:
            raise HTTPException(status_code=400, detail=f"Sample {sample.name} is missing TGA data")
        if option.require_pxrd and not sample.pxrd_image:
            raise HTTPException(status_code=400, detail=f"Sample {sample.name} is missing PXRD data")
        if option.require_bet and not sample.bet_image:
            raise HTTPException(status_code=400, detail=f"Sample {sample.name} is missing BET data")

    submission = OptionSubmission(
        user_id=user.id,
        option_id=option_id,
        instrument_preference=instrument_preference,
        remark=remark,
    )
    session.add(submission)
    session.commit()
    session.refresh(submission)

    for item in samples:
        link = SubmissionSampleLink(
            submission_id=submission.id,
            sample_id=item.get("sample_id"),
            note=item.get("note"),
        )
        session.add(link)
    session.commit()

    return {"id": submission.id}


@app.put("/api/submissions/{submission_id}/status")
def update_submission_status(submission_id: int, payload: dict, session: Session = Depends(get_session), admin: User = Depends(require_staff)):
    submission = session.get(OptionSubmission, submission_id)
    if not submission:
        raise HTTPException(status_code=404, detail="Submission record not found")
    submission.status = payload.get("status", submission.status)
    session.add(submission)
    session.commit()
    return {"detail": "updated"}


@app.delete("/api/submissions/{submission_id}")
def delete_submission(submission_id: int, session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    submission = session.get(OptionSubmission, submission_id)
    if not submission:
        raise HTTPException(status_code=404, detail="Submission record not found")
    if submission.user_id != user.id:
        raise HTTPException(status_code=403, detail="You do not have permission to delete this submission")
    if submission.status == "scheduled":
        raise HTTPException(status_code=400, detail="Scheduled submissions cannot be deleted; contact an administrator")
    reservation = None
    if submission.instrument_assigned_id and submission.scheduled_start and submission.scheduled_end:
        reservation = session.exec(
            select(Reservation)
            .where(
                Reservation.instrument_id == submission.instrument_assigned_id,
                Reservation.user_id == submission.user_id,
                Reservation.start_date == submission.scheduled_start,
                Reservation.end_date == submission.scheduled_end,
            )
        ).first()
    if reservation:
        raise HTTPException(status_code=400, detail="Cannot delete a submission that has an assigned reservation")
    links = session.exec(
        select(SubmissionSampleLink).where(SubmissionSampleLink.submission_id == submission_id)
    ).all()
    for link in links:
        session.delete(link)
    session.delete(submission)
    session.commit()
    return {"detail": "deleted"}


# ----------------------------
# Routes - User Management
# ----------------------------


@app.get("/api/users")
def list_users(session: Session = Depends(get_session), admin: User = Depends(require_super_admin)):
    users = session.exec(select(User).order_by(User.id)).all()
    result = []
    for user in users:
        instruments = session.exec(
            select(Instrument)
            .join(InstrumentAdminLink, InstrumentAdminLink.instrument_id == Instrument.id)
            .where(InstrumentAdminLink.user_id == user.id)
        ).all()
        samples = session.exec(select(Sample).where(Sample.user_id == user.id)).all()
        result.append(
            {
                "id": user.id,
                "username": user.username,
                "full_name": user.full_name,
                "org": user.org,
                "grade": user.grade,
                "phone": user.phone,
                "email": user.email,
                "role": canonical_role_value(user.role),
                "instruments": [{"id": inst.id, "name": inst.name} for inst in instruments],
                "sample_count": len(samples),
            }
        )
    return result


@app.post("/api/users")
def create_user(payload: dict, session: Session = Depends(get_session), admin: User = Depends(require_super_admin)):
    username = payload.get("username")
    password = payload.get("password")
    if not username or not password:
        raise HTTPException(status_code=400, detail="Username and password are required")
    if session.exec(select(User).where(User.username == username)).first():
        raise HTTPException(status_code=400, detail="Username already exists")
    role = canonical_role_value(payload.get("role") or ROLE_USER)
    if role == ROLE_SUPER_ADMIN:
        raise HTTPException(status_code=400, detail="Cannot create another super administrator")
    user = User(
        username=username,
        full_name=payload.get("full_name"),
        org=payload.get("org"),
        grade=payload.get("grade"),
        phone=payload.get("phone"),
        email=payload.get("email"),
        photo_url=payload.get("photo_url"),
        role=role,
        password_hash=hash_password(password),
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return {"id": user.id}


@app.put("/api/users/{user_id}/role")
def update_user_role(user_id: int, payload: dict, session: Session = Depends(get_session), admin: User = Depends(require_super_admin)):
    target = session.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if canonical_role_value(target.role) == ROLE_SUPER_ADMIN:
        raise HTTPException(status_code=400, detail="Cannot change the super administrator role")
    new_role = payload.get("role")
    if new_role not in (ROLE_USER, ROLE_INSTRUMENT_ADMIN):
        raise HTTPException(status_code=400, detail="Invalid role")
    if new_role == ROLE_USER:
        existing_links = session.exec(select(InstrumentAdminLink).where(InstrumentAdminLink.user_id == user_id)).all()
        for link in existing_links:
            session.delete(link)
    target.role = new_role
    session.add(target)
    session.commit()
    session.refresh(target)
    return {"detail": "updated"}


@app.put("/api/users/{user_id}/password")
def update_user_password(user_id: int, payload: dict, session: Session = Depends(get_session), admin: User = Depends(require_super_admin)):
    target = session.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target.role == ROLE_SUPER_ADMIN:
        raise HTTPException(status_code=400, detail="Cannot change the super administrator password here")
    new_password = payload.get("password")
    if not new_password:
        raise HTTPException(status_code=400, detail="Password is required")
    target.password_hash = hash_password(new_password)
    session.add(target)
    session.commit()
    return {"detail": "updated"}


@app.delete("/api/users/{user_id}")
def delete_user(user_id: int, session: Session = Depends(get_session), admin: User = Depends(require_super_admin)):
    target = session.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target.role == ROLE_SUPER_ADMIN:
        raise HTTPException(status_code=400, detail="Cannot delete the super administrator")
    reservations = session.exec(select(Reservation).where(Reservation.user_id == user_id)).all()
    for reservation in reservations:
        session.delete(reservation)
    submissions = session.exec(select(OptionSubmission).where(OptionSubmission.user_id == user_id)).all()
    for submission in submissions:
        links = session.exec(select(SubmissionSampleLink).where(SubmissionSampleLink.submission_id == submission.id)).all()
        for link in links:
            session.delete(link)
        session.delete(submission)
    samples = session.exec(select(Sample).where(Sample.user_id == user_id)).all()
    for sample in samples:
        session.delete(sample)
    admin_links = session.exec(select(InstrumentAdminLink).where(InstrumentAdminLink.user_id == user_id)).all()
    for link in admin_links:
        session.delete(link)
    session.delete(target)
    session.commit()
    return {"detail": "deleted"}


@app.put("/api/users/{user_id}/instruments")
def set_user_instruments(user_id: int, payload: dict, session: Session = Depends(get_session), admin: User = Depends(require_super_admin)):
    target = session.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if canonical_role_value(target.role) != ROLE_INSTRUMENT_ADMIN:
        raise HTTPException(status_code=400, detail="Only instrument admins can be assigned instruments")
    raw_ids = payload.get("instrument_ids", [])
    if not isinstance(raw_ids, list):
        raise HTTPException(status_code=400, detail="instrument_ids must be an array")
    requested_ids = set()
    for item in raw_ids:
        try:
            requested_ids.add(int(item))
        except Exception:
            continue
    valid_instruments = session.exec(select(Instrument).where(Instrument.id.in_(requested_ids))).all() if requested_ids else []
    valid_ids = {inst.id for inst in valid_instruments}
    missing = requested_ids - valid_ids
    if missing:
        raise HTTPException(status_code=400, detail=f"Instrument {', '.join(str(i) for i in sorted(missing))} does not exist")
    existing_links = session.exec(select(InstrumentAdminLink).where(InstrumentAdminLink.user_id == user_id)).all()
    existing_ids = {link.instrument_id for link in existing_links}
    for link in existing_links:
        if link.instrument_id not in requested_ids:
            session.delete(link)
    for inst_id in requested_ids - existing_ids:
        link = InstrumentAdminLink(instrument_id=inst_id, user_id=user_id)
        session.add(link)
    session.commit()
    return {"detail": "updated"}


@app.get("/api/users/{user_id}/samples")
def view_user_samples(user_id: int, session: Session = Depends(get_session), staff: User = Depends(require_staff)):
    target = session.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    return session.exec(select(Sample).where(Sample.user_id == user_id)).all()


@app.put("/api/me/password")
def change_my_password(payload: dict, session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    current = payload.get("current_password")
    new_password = payload.get("new_password")
    if not current or not new_password:
        raise HTTPException(status_code=400, detail="Current and new passwords are required")
    if not verify_password(current, user.password_hash):
        raise HTTPException(status_code=403, detail="Current password is incorrect")
    user.password_hash = hash_password(new_password)
    session.add(user)
    session.commit()
    return {"detail": "updated"}


# ----------------------------
# Health
# ----------------------------

@app.get("/api/health")
def health():
    return {"status": "ok"}


# To run: uvicorn main:app --reload --host 0.0.0.0 --port 8000
