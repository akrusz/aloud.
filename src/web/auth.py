"""Optional password authentication for the web interface."""

from flask import Flask, request, session, redirect, render_template, url_for


def setup_auth(app: Flask, password: str) -> None:
    """Enable simple password authentication on all routes."""
    app.config["AUTH_PASSWORD"] = password

    @app.before_request
    def _require_auth():
        if request.endpoint == "login" or request.path.startswith("/static"):
            return
        if not session.get("authenticated"):
            return redirect(url_for("login"))

    @app.route("/login", methods=["GET", "POST"])
    def login():
        error = None
        if request.method == "POST":
            if request.form.get("password") == app.config["AUTH_PASSWORD"]:
                session["authenticated"] = True
                return redirect("/")
            error = "Incorrect password."
        return render_template("login.html", error=error)
