<template>
  <main class="main-content">
    <form @submit.prevent="edit ? editUserData() : submitUserData()" id="boxAddNewUser" style="display: none" class="card" method="POST" novalidate="" enctype="multipart/form-data">
      <div class="card-header ">
        <h5>{{edit ? `ویرایش کاربر ${edit}` : "افزودن کاربر جدید"}}
          <button @click.prevent="btnCloseNewUser" type="button" class="btn btn-light btn-floating pull-left"><i class="ti-close"></i></button>
        </h5>
      </div>
      <div class="card-body">
        <div class="row">
          <div class="col-lg-6">
            <div class="form-group">
              <label>نام</label>
              <input v-model="form.fname" type="text" class="form-control" placeholder="نام" value="" required="">
            </div>
            <div class="form-group">
              <label>نام خانوادگی</label>
              <input v-model="form.lname" type="text" class="form-control" placeholder="نام خانوادگی" value="" required="">
            </div>
            <div class="form-group">
              <label>جنسیت</label>
              <div class="pb-2">
                <div class="custom-control custom-radio custom-control-inline">
                  <input type="radio" id="customRadioInline1" name="gender" v-model="form.gender" value="1" class="custom-control-input" checked>
                  <label class="custom-control-label" for="customRadioInline1">آقا</label>
                </div>
                <div class="custom-control custom-radio custom-control-inline">
                  <input type="radio" id="customRadioInline2" name="gender" v-model="form.gender" value="0" class="custom-control-input">
                  <label class="custom-control-label" for="customRadioInline2">خانم</label>
                </div>
              </div>
            </div>
            <div class="form-group">
              <label>نام کاربری</label>
              <div class="input-group">
                <div class="input-group-prepend">
                  <span class="input-group-text" id="inputGroupPrepend">@</span>
                </div>
                <input type="text" v-model="form.username" value="" class="form-control" placeholder="نام کاربری" aria-describedby="inputGroupPrepend" required="">
              </div>
            </div>
            <div class="form-group">
              <label>شماره موبایل</label>
              <input type="text" v-model="form.mobile" value="" class="form-control" placeholder="شماره موبایل" value="" required="">
            </div>
          </div>
          <div class="col-lg-6">

            <div class="form-group">
              <label>آدرس ایمیل</label>
              <input type="text" v-model="form.email" value="" class="form-control" placeholder="آدرس ایمیل" value="" required="">
            </div>
            <div class="form-group">
              <label>رمز عبور</label>
              <input type="password" v-model="form.password" class="form-control" placeholder="رمز عبور" value="" required="">
            </div>
            <div class="form-group">
              <label>تکرار رمز عبور</label>
              <input type="password" v-model="form.password2" class="form-control" placeholder="تکرار رمز عبور" value="" required="">
            </div>
            <div class="form-group">
              <label>گروه کاربری</label>
              <select data-module="select2" id="gkey">
                <option value="">انتخاب کنید</option>
                <option v-for="group of groups" :value="group.key">{{group.title}}</option>
              </select>
            </div>
            <div class="form-group">
              <label>آواتار</label>
              <input type="file" value="" @change="setAvatar" class="form-control">
            </div>
          </div>
        </div>
      </div>
      <div class="card-footer">
        <button class="btn btn-primary" type="submit"></button>
      </div>
    </form>

    <div class="card">
      <div class="card-header">
        <h5>لیست کاربران
          <div class="pull-left"><button @click="btnAddNewUser" type="button" class="btn btn-success">افزودن کاربر جدید</button></div>
        </h5>
      </div>
      <div class="card-body p-0">
        <div class="table-responsive">
          <table class="table table-striped table-hover">
            <thead>
            <tr>
              <th>نام</th>
              <th>جنسیت</th>
              <th>نام کابری</th>
              <th>ایمیل</th>
              <th>تاریخ ایجاد</th>
              <th>گروه کاربری</th>
              <th></th>
            </tr>
            </thead>
            <tbody>
            <tr v-for="user of usersList.docs" :class="user.activated?'':'bg-danger-bright'">
              <td>{{user.fname}} {{user.lname}}</td>
              <td>{{user.gender?"آقا" : "خانم"}}</td>
              <td>{{user.username}}</td>
              <td>{{user.email}}</td>
              <td><i class="ti-calendar"></i> {{new Date(user.createdAt).echoFa("Y/m/d")}} <i class="ti-time"></i> {{new Date(user.createdAt).echoFa("H:i")}}</td>
              <td>{{user.group.title}}</td>
              <td class="text-left">
                <div class="btn-group btn-group-sm">
                  <button type="button" class="btn btn-danger" @click="deleteUser(user.username)"><i class="far fa-trash-alt"></i></button>
                  <a @click.prevent="editUser(user.username)" href="#edit" class="btn btn-light"><i class="far fa-edit"></i></a>

                  <button v-if="user.activated" @click="lockUser(user.username, 1)" type="button" class="btn btn-light"><i class="far fa-toggle-on"></i></button>
                  <button v-else type="button" @click="lockUser(user.username, 0)" class="btn btn-light"><i class="far fa-toggle-off"></i></button>
                </div>
              </td>
            </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="card-footer d-flex flex-row-reverse justify-content-between align-items-center">
        <ul class="pagination">
          <li :class="['page-item', 'previous', page==1?'disabled':'']"><a href="#" tabindex="0" class="page-link" @click.prevent="previusPage">قبلی</a></li>
          <li v-for="n in usersList.pages" v-if="usersList.pages>2" :class="['page-item',page==n?'active':'']">
            <a href="#" tabindex="0" class="page-link" @click.prevent="gotoPage(n)">{{n}}</a>
          </li>
          <li :class="['page-item', 'next', (page==usersList.pages)?'disabled':'']"><a href="#" tabindex="0" class="page-link" @click.prevent="nextPage">بعدی</a></li>
        </ul>
        <div class="d-none d-lg-block align-middle">
          <select class="form-control" @change="changeLength" v-model="limit">
            <option v-for="n in [2, 5, 10, 25, 50, 100]" :value="n">{{n}}</option>
          </select>
        </div>
      </div>
    </div>

    <div class="modal fade" id="deleteUser" tabindex="-1" role="dialog" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered" role="document">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">هشدار</h5>
            <button type="button" class="close" data-dismiss="modal" aria-label="Close">
              <i class="ti-close"></i>
            </button>
          </div>
          <div class="modal-body">آیا واقعا می خواهید این کاربر را حذف کنید؟</div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-dismiss="modal">نخیر</button>
            <a href="#1" class="btn btn-danger">آره حذف کن</a>
          </div>
        </div>
      </div>
    </div>
    <div class="modal fade" id="enableUser" tabindex="-1" role="dialog" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered" role="document">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">هشدار</h5>
            <button type="button" class="close" data-dismiss="modal" aria-label="Close">
              <i class="ti-close"></i>
            </button>
          </div>
          <div class="modal-body">آیا واقعا می خواهید این کاربر را فعال کنید؟</div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-dismiss="modal">نخیر</button>
            <a href="#1" class="btn btn-success">آره فعال کن</a>
          </div>
        </div>
      </div>
    </div>
    <div class="modal fade" id="disableUser" tabindex="-1" role="dialog" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered" role="document">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="exampleModalCenterTitle">هشدار</h5>
            <button type="button" class="close" data-dismiss="modal" aria-label="Close">
              <i class="ti-close"></i>
            </button>
          </div>
          <div class="modal-body">آیا واقعا می خواهید این کاربر را غیر فعال کنید؟</div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-dismiss="modal">نخیر</button>
            <a href="#1" class="btn btn-danger">آره غیر فعال کن</a>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<script>
import axios from "axios";
export default {
  data(){
    return {
      edit: "",
      form: {avatar: ""},
      step: 1,
      usersList: {
        docs: []
      },
      groups: [],
      page: 1,
      limit: localStorage.getItem('listDataLength') || 10,
      search: ""
    }
  },
  methods: {
    getUsersList(){
      axios.get("/admin/settings/ws/users", {params: {page: this.page, limit: this.limit, search: this.search}}).then(({data}) => {
        this.usersList = data.users;
        this.groups = data.groups
      });
    },
    setAvatar(e){
      this.form.avatar = e.target.files[0]
    },
    nextPage(){
      this.page++;
      this.getUsersList();
    },
    previusPage(){
      this.page--;
      this.getUsersList();
    },
    gotoPage(n){
      this.page = n;
      this.getUsersList();
    },
    changeLength(){
      localStorage.setItem('listDataLength', this.limit)
      this.getUsersList();
    },
    btnAddNewUser(){
      this.edit = "";
      this.form = {avatar: ""};
      $("#gkey").val("").trigger('change');
      $("#customRadioInline1").prop('checked', 0);
      $("#customRadioInline2").prop('checked', 0);
      $("form button[type=submit]").text("ایجاد کاربر");
      $("#boxAddNewUser").slideUp(150);
      $("#boxAddNewUser").slideDown(150);
    },
    btnCloseNewUser(){
      $("#boxAddNewUser").slideUp(150);
    },
    editUser(username){
      this.edit = username;
      $("form button[type=submit]").text("ویرایش کاربر");
      $("#boxAddNewUser").slideUp(150);
      $("#boxAddNewUser").slideDown(150);
      axios.get('/admin/settings/ws/addUser', {params: {username}}).then(({data}) => {
        if( data.ok ){
          this.$set(this.form, 'fname', data.user.fname);
          this.$set(this.form, 'lname', data.user.lname);
          if( data.user.gender ) $("#customRadioInline1").prop('checked', 1);
          else $("#customRadioInline2").prop('checked', 1);

          this.$set(this.form, 'username', data.user.username);
          this.$set(this.form, 'mobile', data.user.mobile);
          this.$set(this.form, 'email', data.user.email);
          $("#gkey").val(data.user.gkey).trigger('change');
        }
      });

    },
    editUserData(){
      let formData = new FormData();
      for(let i in this.form){
        formData.append(i, this.form[i]);
      }
      axios.put('/admin/settings/ws/addUser', formData, {
        params: {username: this.edit},
        headers: {
          'Content-Type': 'multipart/form-data'
        }}).then(({data}) => {
        if( data.ok ){
          $("#boxAddNewUser").slideUp(150);
          toastr['success'](data.msg);
          this.getUsersList();
        }else{
          toastr['error'](data.error.join('<br>'));
        }
      });
    },
    submitUserData(){
      let formData = new FormData();
      for(let i in this.form){
        formData.append(i, this.form[i]);
      }
      console.log(this.form)
      console.log(formData)
      axios.post('/admin/settings/ws/addUser', formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      }).then(({data}) => {
        if( data.ok ){
          $("#boxAddNewUser").slideUp(150);
          toastr['success'](data.msg);
          this.getUsersList();
        }else{
          toastr['error'](data.error.join('<br>'));
        }
      });
    },
    deleteUser(username){
      const vm = this;
      swal({
        title: "آیا اطمینان دارید؟",
        text: `آیا واقعا می خواهید کاربر ${username} را حذف کنید؟`,
        icon: "warning",
        buttons: {
          confirm : 'بله',
          cancel : 'خیر'
        },
        dangerMode: true
      })
          .then(function(willDelete) {
            if (willDelete) {
              axios.delete("/admin/settings/ws/addUser", {params: {username}}).then(({data}) => {
                if( data.ok ){
                  swal(`کاربر ${username} با موفقیت حذف شد.`, {
                    icon: "success",
                    button: "باشه"
                  });
                  vm.getUsersList();
                }
              });
            }
          });
    },
    lockUser(username, status){
      const vm = this;
      const strStatus = status ? "غیر فعال" : "فعال";
      swal({
        title: "آیا اطمینان دارید؟",
        text: `آیا واقعا می خواهید کاربر ${username} را ${strStatus} کنید؟`,
        icon: "warning",
        buttons: {
          confirm : 'بله',
          cancel : 'خیر'
        },
        dangerMode: true
      }).then(function(willLock) {
        if (willLock) {
          const value = status ? {lock:username} : {unlock:username};
          axios.get("/admin/settings/ws/users", {params: value}).then(({data}) => {
            if( data.ok ){
              swal(`کاربر ${username} با موفقیت ${strStatus} شد.`, {
                icon: "success",
                button: "باشه"
              });
              vm.getUsersList();
            }
          });
        }
      });
    }
  },
  created() {
    this.getUsersList();
  },
  mounted() {
    let t = this;
    $(function(){
      $("#gkey").change(function(){
        t.form.gkey = $(this).val();
      });
      // $("[name=gender][value='<%= check('gender') ? 1 : 0 %>']").prop("checked", true);
      // $("[name=gkey]").val('<%=check('gkey')%>').trigger('change');
    });
  }
}
</script>

<style scoped>

</style>
