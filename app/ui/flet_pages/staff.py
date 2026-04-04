import flet as ft
from app.core.i18n import _
from app.core.auth import hash_password
from app.ui.components.design_helpers import (
    build_dialog,
    open_dialog,
    primary_button,
    refresh_action,
    secondary_button,
    standard_appbar,
)
from app.ui.components.feedback import show_error, show_success
from app.ui.components.ui_sync import UIEventTopic, publish_ui_event
from app.ui.components.ui_tokens import INPUT_HEIGHT, SPACE_LG, SPACE_MD, TITLE_SIZE

def StaffView(page: ft.Page, repo):
    items_list = ft.ListView(expand=True, spacing=SPACE_MD)
    summary_text = ft.Text("", color=ft.colors.GREY_700)

    status_filter = ft.Dropdown(
        label=_("Status"),
        value="All",
        width=180,
        options=[
            ft.dropdown.Option("All", _("All")),
            ft.dropdown.Option("Active", _("Active")),
            ft.dropdown.Option("Inactive", _("Inactive")),
        ],
    )

    def load_users(term=""):
        items_list.controls.clear()
        users = repo.get_users()
        
        if term:
            term = term.lower()
            users = [u for u in users if
                term in u.get("username", "").lower() or
                term in (u.get("full_name") or "").lower()]

        if status_filter.value == "Active":
            users = [u for u in users if u.get("is_active", True)]
        elif status_filter.value == "Inactive":
            users = [u for u in users if not u.get("is_active", True)]

        active_count = len([u for u in users if u.get("is_active", True)])
        summary_text.value = f"{_('Users')}: {len(users)} | {_('Active')}: {active_count} | {_('Inactive')}: {len(users) - active_count}"

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
                                title=ft.Text(u.get("username", ""), weight=ft.FontWeight.BOLD, size=16),
                                subtitle=ft.Text(f"{u.get('full_name', 'N/A')} | {_('Role')}: {role_name}", size=13),
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
                            padding=10
                        )
                    )
                )
        page.update()

    def show_user_dialog(user=None):
        """Show dialog to create/edit user."""
        try:
            roles = repo.get_metadata("roles") or []
        except Exception as ex:
            roles = []
            show_error(page, f"{_('Error loading roles')}: {str(ex)}")

        if not roles:
            show_error(page, _("No roles found. Please add a role first."))
            return

        def save_user(e):
            try:
                if not username_field.value:
                    show_error(page, _("Username is required"))
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
                        show_error(page, _("Password must be at least 6 characters"))
                        return
                    user_data["password_hash"] = hash_password(password_field.value)
                    repo.add_user(user_data)
                    msg = _("User created successfully")
                else:
                    repo.update_user(user["id"], user_data)
                    msg = _("User updated successfully")

                dialog.open = False
                publish_ui_event(page, UIEventTopic.CUSTOMERS)
                load_users(search_input.value)
                show_success(page, msg)
            except Exception as ex:
                show_error(page, f"{_('Error')}: {str(ex)}")
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
            visible=not user
        )
        role_dropdown = ft.Dropdown(
            label=_("Role"),
            value=user.get("role_id") if user else (roles[0]["id"] if roles else None),
            options=[ft.dropdown.Option(r["id"], r["name"]) for r in roles]
        )

        dialog = build_dialog(
            _("Edit User") if user else _("New User"),
            ft.Container(
                ft.Column([username_field, fullname_field, password_field, role_dropdown], tight=True, spacing=10),
                width=350,
            ),
            [],
        )
        dialog.actions = [
            secondary_button(_("Cancel"), on_click=lambda e: setattr(dialog, "open", False) or page.update()),
            primary_button(_("Save"), on_click=save_user),
        ]
        open_dialog(page, dialog)

    def show_role_dialog(e=None):
        """Quick dialog to add a role used by staff accounts."""
        role_name = ft.TextField(label=_("Role Name"), autofocus=True)

        def save_role(_):
            name = (role_name.value or "").strip()
            if not name:
                show_error(page, _("Role name is required"))
                return
            try:
                repo.add_metadata("roles", name)
                dialog.open = False
                show_success(page, _("Role added successfully"))
            except Exception as ex:
                show_error(page, f"{_('Error')}: {str(ex)}")

        dialog = build_dialog(
            _("Add Role"),
            ft.Container(content=role_name, width=320),
            [],
        )
        dialog.actions = [
            secondary_button(_("Cancel"), on_click=lambda ev: setattr(dialog, "open", False) or page.update()),
            primary_button(_("Save"), on_click=save_role),
        ]
        open_dialog(page, dialog)

    def show_password_dialog(user):
        """Dialog to change user password."""
        def change_password(e):
            if not new_password.value or len(new_password.value) < 6:
                show_error(page, _("Password must be at least 6 characters"))
                return

            if new_password.value != confirm_password.value:
                show_error(page, _("Passwords do not match"))
                return

            repo.update_user(user["id"], {"password_hash": hash_password(new_password.value)})
            dialog.open = False
            publish_ui_event(page, UIEventTopic.CUSTOMERS)
            show_success(page, _("Password changed successfully"))

        new_password = ft.TextField(label=_("New Password"), password=True, can_reveal_password=True, autofocus=True)
        confirm_password = ft.TextField(label=_("Confirm Password"), password=True, can_reveal_password=True)

        dialog = build_dialog(
            f"{_('Change Password')}: {user.get('username', '')}",
            ft.Column([new_password, confirm_password], tight=True, spacing=10),
            [],
        )
        dialog.actions = [
            secondary_button(_("Cancel"), on_click=lambda e: setattr(dialog, "open", False) or page.update()),
            primary_button(_("Save"), on_click=change_password),
        ]
        open_dialog(page, dialog)

    def toggle_user_status(user, new_status):
        """Toggle user active status."""
        repo.update_user(user["id"], {"is_active": new_status})
        publish_ui_event(page, UIEventTopic.CUSTOMERS)
        load_users(search_input.value)
        show_success(page, _("User status updated"))

    search_input = ft.TextField(
        label=_("Search by username or name..."),
        prefix_icon=ft.icons.SEARCH,
        height=INPUT_HEIGHT,
        text_size=15,
        expand=True,
        on_change=lambda e: load_users(e.control.value)
    )
    status_filter.on_change = lambda e: load_users(search_input.value)

    load_users()

    return ft.View(
        "/staff",
        [
            standard_appbar(_("Staff Management"), on_back=lambda _: page.go("/")),
            ft.Container(
                content=ft.Column([
                    ft.Row([
                        ft.Text(_("Staff Members"), size=TITLE_SIZE, weight=ft.FontWeight.BOLD),
                        ft.Row([
                            refresh_action(on_click=lambda _: load_users(search_input.value), tooltip=_("Refresh")),
                            secondary_button(_("+ Add Role"), on_click=show_role_dialog, icon=ft.icons.ADMIN_PANEL_SETTINGS),
                            primary_button(_("+ Add Staff"), on_click=lambda _: show_user_dialog(), icon=ft.icons.PERSON_ADD),
                        ])
                    ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
                    ft.Row([search_input, status_filter]),
                    summary_text,
                    ft.Divider(height=SPACE_LG),
                    items_list,
                ], expand=True, spacing=SPACE_MD),
                padding=24,
                expand=True
            )
        ]
    )






