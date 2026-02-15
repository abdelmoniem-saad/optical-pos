import flet as ft
from app.core.i18n import _
from app.core.auth import hash_password

def StaffView(page: ft.Page, repo):
    items_list = ft.ListView(expand=True, spacing=5)

    def load_users(term=""):
        items_list.controls.clear()
        users = repo.get_users()
        
        if term:
            term = term.lower()
            users = [u for u in users if
                term in u.get("username", "").lower() or
                term in (u.get("full_name") or "").lower()]

        if not users:
            items_list.controls.append(
                ft.ListTile(title=ft.Text(_("No staff members found"), italic=True, color=ft.colors.GREY_700))
            )
        else:
            for u in users:
                role_name = u.get("role", {}).get("name") if u.get("role") else _("No Role")
                is_active = u.get("is_active", True)

                items_list.controls.append(
                    ft.Card(
                        content=ft.Container(
                            content=ft.ListTile(
                                leading=ft.Container(
                                    ft.Icon(ft.icons.PERSON, color=ft.colors.WHITE, size=25),
                                    bgcolor=ft.colors.GREEN_500 if is_active else ft.colors.GREY_500,
                                    border_radius=25,
                                    padding=10,
                                    width=50,
                                    height=50
                                ),
                                title=ft.Text(u.get("username", ""), weight=ft.FontWeight.BOLD),
                                subtitle=ft.Text(f"{u.get('full_name', 'N/A')} | {_('Role')}: {role_name}"),
                                trailing=ft.Row([
                                    ft.Container(
                                        ft.Text(_("Active") if is_active else _("Inactive"), size=12, color=ft.colors.WHITE),
                                        bgcolor=ft.colors.GREEN_500 if is_active else ft.colors.GREY_500,
                                        padding=ft.padding.symmetric(horizontal=10, vertical=5),
                                        border_radius=15
                                    ),
                                    ft.PopupMenuButton(
                                        items=[
                                            ft.PopupMenuItem(text=_("Edit"), icon=ft.icons.EDIT, on_click=lambda e, user=u: show_user_dialog(user)),
                                            ft.PopupMenuItem(text=_("Change Password"), icon=ft.icons.LOCK, on_click=lambda e, user=u: show_password_dialog(user)),
                                            ft.PopupMenuItem(
                                                text=_("Deactivate") if is_active else _("Activate"),
                                                icon=ft.icons.BLOCK if is_active else ft.icons.CHECK,
                                                on_click=lambda e, user=u, active=is_active: toggle_user_status(user, not active)
                                            ),
                                        ]
                                    )
                                ], tight=True),
                            ),
                            padding=5
                        )
                    )
                )
        page.update()

    def show_user_dialog(user=None):
        """Show dialog to create/edit user."""
        roles = repo.get_metadata("roles")

        def save_user(e):
            if not username_field.value:
                page.snack_bar = ft.SnackBar(ft.Text(_("Username is required")))
                page.snack_bar.open = True
                page.update()
                return

            user_data = {
                "username": username_field.value,
                "full_name": fullname_field.value,
                "role_id": role_dropdown.value,
                "is_active": True
            }

            # Add password for new users
            if not user:
                if not password_field.value or len(password_field.value) < 6:
                    page.snack_bar = ft.SnackBar(ft.Text(_("Password must be at least 6 characters")))
                    page.snack_bar.open = True
                    page.update()
                    return
                user_data["password_hash"] = hash_password(password_field.value)
                repo.add_user(user_data)
                page.snack_bar = ft.SnackBar(ft.Text(_("User created successfully")))
            else:
                repo.update_user(user["id"], user_data)
                page.snack_bar = ft.SnackBar(ft.Text(_("User updated successfully")))

            dialog.open = False
            page.snack_bar.open = True
            load_users(search_input.value)
            page.update()

        username_field = ft.TextField(
            label=_("Username") + " *",
            value=user.get("username", "") if user else "",
            autofocus=True
        )
        fullname_field = ft.TextField(
            label=_("Full Name"),
            value=user.get("full_name", "") if user else ""
        )
        password_field = ft.TextField(
            label=_("Password") + " *" if not user else _("Password"),
            password=True,
            can_reveal_password=True,
            visible=not user  # Only show for new users
        )
        role_dropdown = ft.Dropdown(
            label=_("Role"),
            value=user.get("role_id") if user else (roles[0]["id"] if roles else None),
            options=[ft.dropdown.Option(r["id"], r["name"]) for r in roles]
        )

        dialog = ft.AlertDialog(
            title=ft.Text(_("Edit User") if user else _("New User")),
            content=ft.Container(
                ft.Column([username_field, fullname_field, password_field, role_dropdown], tight=True, spacing=10),
                width=350
            ),
            actions=[
                ft.TextButton(_("Cancel"), on_click=lambda e: setattr(dialog, "open", False) or page.update()),
                ft.ElevatedButton(_("Save"), on_click=save_user)
            ]
        )
        page.dialog = dialog
        dialog.open = True
        page.update()

    def show_password_dialog(user):
        """Dialog to change user password."""
        def change_password(e):
            if not new_password.value or len(new_password.value) < 6:
                page.snack_bar = ft.SnackBar(ft.Text(_("Password must be at least 6 characters")))
                page.snack_bar.open = True
                page.update()
                return

            if new_password.value != confirm_password.value:
                page.snack_bar = ft.SnackBar(ft.Text(_("Passwords do not match")))
                page.snack_bar.open = True
                page.update()
                return

            repo.update_user(user["id"], {"password_hash": hash_password(new_password.value)})
            dialog.open = False
            page.snack_bar = ft.SnackBar(ft.Text(_("Password changed successfully")))
            page.snack_bar.open = True
            page.update()

        new_password = ft.TextField(label=_("New Password"), password=True, can_reveal_password=True, autofocus=True)
        confirm_password = ft.TextField(label=_("Confirm Password"), password=True, can_reveal_password=True)

        dialog = ft.AlertDialog(
            title=ft.Text(f"{_('Change Password')}: {user.get('username', '')}"),
            content=ft.Column([new_password, confirm_password], tight=True, spacing=10),
            actions=[
                ft.TextButton(_("Cancel"), on_click=lambda e: setattr(dialog, "open", False) or page.update()),
                ft.ElevatedButton(_("Save"), on_click=change_password)
            ]
        )
        page.dialog = dialog
        dialog.open = True
        page.update()

    def toggle_user_status(user, new_status):
        """Toggle user active status."""
        repo.update_user(user["id"], {"is_active": new_status})
        page.snack_bar = ft.SnackBar(ft.Text(_("User status updated")))
        page.snack_bar.open = True
        load_users(search_input.value)
        page.update()

    search_input = ft.TextField(
        label=_("Search by username or name..."),
        prefix_icon=ft.icons.SEARCH,
        expand=True,
        on_change=lambda e: load_users(e.control.value)
    )

    load_users()

    return ft.View(
        "/staff",
        [
            ft.AppBar(
                title=ft.Text(_("Staff Management")),
                bgcolor=ft.colors.BLUE_700,
                color=ft.colors.WHITE,
                leading=ft.IconButton(ft.icons.ARROW_BACK, on_click=lambda _: page.go("/"))
            ),
            ft.Container(
                content=ft.Column([
                    ft.Row([
                        ft.Text(_("Staff Members"), size=25, weight=ft.FontWeight.BOLD),
                        ft.ElevatedButton(_("+ Add Staff"), icon=ft.icons.PERSON_ADD, on_click=lambda _: show_user_dialog())
                    ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
                    search_input,
                    items_list,
                ], expand=True),
                padding=20,
                expand=True
            )
        ]
    )






