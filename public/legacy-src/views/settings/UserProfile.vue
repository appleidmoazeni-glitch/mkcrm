<template>
  <main class="main-content">
    <form @submit.prevent="saveUserDate" class="card" method="POST" novalidate="" enctype="multipart/form-data">
      <div class="card-header">
        <h5>ویرایش اطلاعات پروفایل</h5>
      </div>
      <div class="card-body">
        <div class="row">
          <div class="col-lg-6">
            <div class="form-group">
              <label>نام</label>
              <input v-model="user.fname" type="text" class="form-control" placeholder="نام" required="">
            </div>

            <div class="form-group">
              <label>نام خانوادگی</label>
              <input v-model="user.lname" type="text" class="form-control" placeholder="نام خانوادگی" required="">
            </div>

            <div class="form-group">
              <label>آواتار</label>
              <input type="file" ref="avatar" class="form-control">
            </div>

            <div class="form-group">
              <label>جنسیت</label>
              <div class="pb-2">
                <div class="custom-control custom-radio custom-control-inline">
                  <input type="radio" id="customRadioInline1" name="gender" value="1" class="custom-control-input" :checked="user.gender">
                  <label class="custom-control-label" for="customRadioInline1">آقا</label>
                </div>
                <div class="custom-control custom-radio custom-control-inline">
                  <input type="radio" id="customRadioInline2" name="gender" value="0" class="custom-control-input" :checked="!user.gender">
                  <label class="custom-control-label" for="customRadioInline2">خانم</label>
                </div>
              </div>
            </div>
          </div>
          <div class="col-lg-6">
            <div class="form-group">
              <label>آدرس ایمیل</label>
              <input type="text" v-model="user.email" class="form-control" placeholder="آدرس ایمیل" required="">
            </div>

            <div class="form-group">
              <label>نام کاربری</label>
              <input type="text" v-model="user.username" class="form-control" readonly>
            </div>

            <div class="form-group">
              <label>شماره موبایل</label>
              <input type="text" v-model="user.mobile" class="form-control" readonly>
            </div>

          </div>
        </div>
      </div>
      <div class="card-footer">
        <button class="btn btn-primary" type="submit">ذخیره تغییرات</button>
      </div>
    </form>

  </main>
</template>
<script>
import axios from "axios";

export default {
  methods:{
    saveUserDate(){
      let formData = new FormData();
      formData.append('fname', this.user.fname);
      formData.append('lname', this.user.lname);
      formData.append('gender', $("[name=gender]:checked").val());
      formData.append('email', this.user.email);
      formData.append('mobile', this.user.mobile);
      if( this.$refs.avatar.value ){
        formData.append('avatar', this.$refs.avatar.files[0]);
      }
      axios.post('/admin/settings/userProfile', formData, {
        params: {username: this.edit},
        headers: {
          'Content-Type': 'multipart/form-data'
        }}).then(({data}) => {
        if( data.ok ){
          toastr['success']("تغییرات با موفقیت ذخیره شدند.");
        }else{
          toastr['error'](data.error.join('<br>'));
        }
      });
    }
  },
  computed: {
    user(){
      return JSON.parse(JSON.stringify(this.$store.state.user));
    }
  }
}
</script>
